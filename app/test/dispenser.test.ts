import fs from "node:fs";
import kaspaInit from "kaspa-wasm";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as engine from "../src/shared/lib/engine";
import { claimDrip, dispenserAddress, ensureFunds } from "../src/shared/lib/dispenser";

// The claim's transaction plumbing is stubbed: scriptInput hands the lane
// itself through as the input, so submitSpec sees which lane a claim spends.
vi.mock("../src/shared/lib/engine", async (original) => ({
  ...(await original<typeof engine>()),
  scriptInput: vi.fn((lane: unknown) => lane),
  submitSpec: vi.fn(),
  walletAddress: vi.fn(),
  walletBalance: vi.fn(),
}));

const TKAS = 100_000_000n;
const VIRTUAL_DAA = 1_000_000n;
type Lane = { outpoint: { transactionId: string }; amount: bigint; blockDaaScore: bigint };

/** `n` lanes, all past the cooldown; earlier lanes hold more. */
function lanes(n: number): Lane[] {
  return Array.from({ length: n }, (_, i) => ({
    outpoint: { transactionId: `lane-${i}` },
    amount: BigInt(1000 - i) * TKAS,
    blockDaaScore: 0n,
  }));
}

function rpcWith(entries: Lane[]) {
  return {
    getUtxosByAddresses: vi.fn(async () => ({ entries })),
    getBlockDagInfo: vi.fn(async () => ({ virtualDaaScore: VIRTUAL_DAA })),
  } as unknown as engine.Rpc;
}

/** A node that accepts each lane's first spend and rejects any later one,
 * as a mempool does with a double spend. */
function nodeSpending(spent: Set<string>) {
  vi.mocked(engine.submitSpec).mockImplementation(async (_rpc, _keys, specOf) => {
    const lane = specOf(1000n).inputs[0] as unknown as Lane;
    const id = lane.outpoint.transactionId;
    await Promise.resolve(); // let other claimers interleave, like a real round trip
    if (spent.has(id)) throw new Error(`double spend of ${id}`);
    spent.add(id);
    return { txid: `claim-of-${id}` } as Awaited<ReturnType<typeof engine.submitSpec>>;
  });
}

/** Deterministic Math.random, so the spread below is the same every run. */
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

const KASPA_WASM = new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url);
beforeAll(async () => {
  await kaspaInit(fs.readFileSync(KASPA_WASM));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(engine.walletAddress).mockReturnValue(dispenserAddress());
  vi.spyOn(Math, "random").mockImplementation(seededRandom(7));
});
afterEach(() => vi.restoreAllMocks());

test("players claiming at the same moment spread across lanes instead of colliding", async () => {
  const spent = new Set<string>();
  nodeSpending(spent);
  const rpc = rpcWith(lanes(40));
  const to = dispenserAddress(); // any valid address will do as the payout

  const results = await Promise.allSettled(Array.from({ length: 20 }, () => claimDrip(rpc, to)));

  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  expect(spent.size).toBe(20);
  // Ranked selection would have sent every claimer at the three largest
  // lanes: at most three claims could ever win a simultaneous burst.
  const firstTries = vi
    .mocked(engine.submitSpec)
    .mock.calls.slice(0, 20)
    .map(([, , specOf]) => (specOf(1000n).inputs[0] as unknown as Lane).outpoint.transactionId);
  expect(new Set(firstTries).size).toBeGreaterThan(10);
});

test("a lane lost to a race falls through to another", async () => {
  const spent = new Set(["lane-0", "lane-1", "lane-2", "lane-3"]);
  nodeSpending(spent);

  const txid = await claimDrip(rpcWith(lanes(5)), dispenserAddress());

  expect(txid).toBe("claim-of-lane-4");
});

test("a claim stops after a bounded number of lanes when every spend is refused", async () => {
  vi.mocked(engine.submitSpec).mockRejectedValue(new Error("node says no"));

  await expect(claimDrip(rpcWith(lanes(50)), dispenserAddress())).rejects.toThrow("node says no");
  expect(engine.submitSpec).toHaveBeenCalledTimes(8);
});

test("a claim that is accepted but never lands is retried once on another lane", async () => {
  vi.useFakeTimers();
  nodeSpending(new Set());
  const need = 5n * TKAS;
  // Empty until the second claim lands: the first was silently dropped.
  let landed = false;
  vi.mocked(engine.walletBalance).mockImplementation(async () => (landed ? 10n * TKAS : 0n));
  let claims = 0;
  const rpc = rpcWith(lanes(10));
  vi.mocked(engine.submitSpec).mockImplementation(async () => {
    if (++claims === 2) landed = true;
    return { txid: `claim-${claims}` } as Awaited<ReturnType<typeof engine.submitSpec>>;
  });

  const done = ensureFunds(rpc, {} as engine.PrivateKey, need);
  await vi.advanceTimersByTimeAsync(2000 * 21);
  await expect(done).resolves.toBeUndefined();
  expect(claims).toBe(2);
  vi.useRealTimers();
});

test("two claims that never land fail the seat", async () => {
  vi.useFakeTimers();
  vi.mocked(engine.walletBalance).mockResolvedValue(0n);
  vi.mocked(engine.submitSpec).mockResolvedValue({ txid: "dropped" } as Awaited<
    ReturnType<typeof engine.submitSpec>
  >);

  const done = ensureFunds(rpcWith(lanes(10)), {} as engine.PrivateKey, 5n * TKAS);
  const failed = expect(done).rejects.toThrow("SEAT_SETUP_FAILED");
  await vi.advanceTimersByTimeAsync(2000 * 41);
  await failed;
  expect(engine.submitSpec).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
