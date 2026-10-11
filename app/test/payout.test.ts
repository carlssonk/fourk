import { beforeEach, expect, test, vi } from "vitest";
import { fourk2AutoActions } from "../src/shared/modes/fourk2/actions";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";
import { FREE_STAKE, type Match } from "../src/shared/lib/match";
import * as engine from "../src/shared/lib/engine";
import { ensureFunds } from "../src/shared/lib/dispenser";

vi.mock("../src/shared/lib/engine", async (original) => ({
  ...(await original<typeof engine>()),
  gameUtxoAge: vi.fn(),
  signedTerminal: vi.fn(async () => "paid"),
}));
vi.mock("../src/shared/lib/dispenser", () => ({ ensureFunds: vi.fn() }));

const match: Match = {
  network: "testnet-10",
  mode: "fourk2",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE * 2n,
  state: {
    p1: "11".repeat(32),
    p2: "22".repeat(32),
    board: Uint8Array.from([1, 1, 1, 1, ...Array(38).fill(0)]),
    moveCount: 4,
    stake: FREE_STAKE,
    moveTimeout: 600,
    deadline: 100_000,
  },
  simul: { ...zeroCore2(600), pendingWin: 1 },
};
const rpc = {} as engine.Rpc;
const key = {} as engine.PrivateKey;
const sweep = () =>
  fourk2AutoActions(match, { myPk: match.state.p1, role: "p1" }).find((a) => a.key === "sweep")!;
beforeEach(() => vi.clearAllMocks());

test("the sweep is ready only when the chain reaches the challenge age", async () => {
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(599);
  expect(await sweep().scheduleMs!(rpc)).toBeGreaterThan(0);
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  expect(await sweep().scheduleMs!(rpc)).toBe(0);
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(null);
  expect(await sweep().scheduleMs!(rpc)).toBeGreaterThan(0);
});

test("a winning payout pays its fee from the pot even with an empty wallet", async () => {
  vi.mocked(ensureFunds).mockRejectedValue(new Error("LOW_BALANCE"));
  await expect(sweep().run(rpc, key, match)).resolves.toMatchObject({ kind: "finished" });
  expect(ensureFunds).not.toHaveBeenCalled();
  expect(engine.signedTerminal).toHaveBeenCalledOnce();
});
