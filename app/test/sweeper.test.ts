import { beforeEach, expect, test, vi } from "vitest";
import { createSweeper, MAX_ATTEMPTS, RATE_LIMIT } from "../sweeper/sweeper";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";
import { FREE_STAKE, NETWORK_ID, matchToJson, type Match } from "../src/shared/lib/match";
import * as engine from "../src/shared/lib/engine";

vi.mock("../src/shared/lib/engine", async (original) => ({
  ...(await original<typeof engine>()),
  fetchGameUtxo: vi.fn(),
  gameUtxoAge: vi.fn(),
  pinnedWinner: vi.fn(async () => "swept"),
}));

const board = new Uint8Array(42);
board.set([1, 1, 1, 1], 0);
board.set([2, 2, 2], 6);
board[12] = 2;
const match: Match = {
  network: NETWORK_ID,
  mode: "fourk2",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE * 2n,
  state: {
    p1: "11".repeat(32),
    p2: "22".repeat(32),
    board,
    moveCount: 8,
    stake: FREE_STAKE,
    moveTimeout: 600,
    deadline: 100_000,
  },
  simul: { ...zeroCore2(600), round: 4, pendingWin: 1 },
  profiles: { p1: { name: "Al", avatar: "0".repeat(16) } },
};
// The chain's view of the game UTXO: the pot it really holds.
const entry = {
  outpoint: { transactionId: match.txid },
  amount: 777n,
  covenantId: match.covenantId,
};
const rpc = {} as engine.Rpc;
let clock = 0;
const sweeper = () => createSweeper(rpc, () => clock);
const body = (m: Partial<Match> = {}) => matchToJson({ ...match, ...m });

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  vi.mocked(engine.fetchGameUtxo).mockResolvedValue(entry as never);
});

test("queues a pending win only once the chain confirms it", async () => {
  const s = sweeper();
  vi.mocked(engine.fetchGameUtxo).mockResolvedValueOnce(null);
  expect((await s.intake(body(), "a")).status).toBe(404);
  expect(s.size()).toBe(0);
  expect((await s.intake(body(), "a")).status).toBe(202);
  // A repeat is answered from the queue, without another chain lookup.
  expect((await s.intake(body(), "b")).status).toBe(202);
  expect(engine.fetchGameUtxo).toHaveBeenCalledTimes(2);
  expect(s.size()).toBe(1);
});

test("refuses anything that is not a pending, single Fourk win", async () => {
  const s = sweeper();
  const twoLines = board.slice();
  twoLines[9] = 2;
  twoLines[12] = 0;
  for (const [bad, why] of [
    ["not json", "not a match"],
    [body({ network: "mainnet" }), "wrong network"],
    [body({ simul: { ...zeroCore2(600), round: 4 } }), "no pending win"],
    [body({ state: { ...match.state, board: twoLines } }), "double win"],
  ])
    expect(await s.intake(bad!, "a")).toEqual({ status: 400, body: why });
  expect((await s.intake("x".repeat(9000), "b")).status).toBe(413);
  expect(engine.fetchGameUtxo).not.toHaveBeenCalled();
});

test("limits each client, not everyone", async () => {
  const s = sweeper();
  for (let i = 0; i < RATE_LIMIT; i++) await s.intake("x", "a");
  expect((await s.intake("x", "a")).status).toBe(429);
  expect((await s.intake("x", "b")).status).toBe(400);
  clock += 60_000;
  expect((await s.intake("x", "a")).status).toBe(400);
});

test("sweeps when the window ends, paying the chain's pot to the winner", async () => {
  const s = sweeper();
  await s.intake(body(), "a");
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(500);
  await s.tick();
  expect(engine.pinnedWinner).not.toHaveBeenCalled();
  // Not looked at again until the window should have ended.
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  await s.tick();
  expect(engine.gameUtxoAge).toHaveBeenCalledOnce();
  clock += 100 * 100 + 2000;
  await s.tick();
  expect(engine.pinnedWinner).toHaveBeenCalledOnce();
  const [, , swept, entryName, winner] = vi.mocked(engine.pinnedWinner).mock.calls[0]!;
  expect(entryName).toBe("sweep_win");
  expect(winner).toBe(match.state.p1);
  expect(swept.value).toBe(777n);
  expect(swept.profiles).toBeUndefined();
  expect(s.size()).toBe(0);
});

test("drops a match someone else settled, and gives up after repeated failures", async () => {
  const s = sweeper();
  await s.intake(body(), "a");
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(null);
  await s.tick();
  expect(s.size()).toBe(0);
  expect(engine.pinnedWinner).not.toHaveBeenCalled();

  await s.intake(body(), "a");
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  vi.mocked(engine.pinnedWinner).mockRejectedValue(new Error("node said no"));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await s.tick();
    clock += 15_000 * MAX_ATTEMPTS;
  }
  expect(engine.pinnedWinner).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  expect(s.size()).toBe(0);
});
