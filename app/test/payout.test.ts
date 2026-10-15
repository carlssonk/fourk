import { beforeEach, expect, test, vi } from "vitest";
import { fourk2Actions, fourk2AutoActions } from "../src/shared/modes/fourk2/actions";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";
import { FREE_STAKE, type Match } from "../src/shared/lib/match";
import * as engine from "../src/shared/lib/engine";
import { ensureFunds } from "../src/shared/lib/dispenser";

vi.mock("../src/shared/lib/engine", async (original) => ({
  ...(await original<typeof engine>()),
  gameUtxoAge: vi.fn(),
  fetchGameUtxo: vi.fn(async () => ({})),
  pinnedWinner: vi.fn(async () => "paid"),
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
const sweep = (role: "p1" | "p2" = "p1") =>
  fourk2AutoActions(match, { myPk: match.state[role], role }).find((a) => a.key === "sweep")!;
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
  expect(engine.pinnedWinner).toHaveBeenCalledOnce();
});

test("the loser's client pays the winner a little after the window", async () => {
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  expect(await sweep("p2").scheduleMs!(rpc)).toBeGreaterThan(0);
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(650);
  expect(await sweep("p2").scheduleMs!(rpc)).toBe(0);
  await expect(sweep("p2").run(rpc, key, match)).resolves.toMatchObject({
    kind: "finished",
    message: "Your opponent connected four.",
  });
  expect(engine.pinnedWinner).toHaveBeenCalledWith(
    rpc,
    expect.anything(),
    match,
    "sweep_win",
    match.state.p1,
    { sequence: 600n },
  );
});

test("the match list offers Collect to the winner once the window ends", async () => {
  const { collectWait, collect } = fourk2Actions;
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(450);
  expect(await collectWait!(rpc, match, match.state.p1)).toBe(150);
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  expect(await collectWait!(rpc, match, match.state.p1)).toBe(0);
  // Not the loser's to collect, and nothing once the pot has left.
  expect(await collectWait!(rpc, match, match.state.p2)).toBeNull();
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(null);
  expect(await collectWait!(rpc, match, match.state.p1)).toBeNull();
  await expect(collect!(rpc, match)).resolves.toMatch(/you win/i);
  expect(engine.pinnedWinner).toHaveBeenCalledOnce();
  // Paid by someone else since the button appeared: still the winner's.
  vi.mocked(engine.fetchGameUtxo).mockResolvedValueOnce(null);
  await expect(collect!(rpc, match)).resolves.toMatch(/you win/i);
  expect(engine.pinnedWinner).toHaveBeenCalledOnce();
});

test("a double win is never offered as a collect", async () => {
  const board = match.state.board.slice();
  board.set([2, 2, 2, 2], 6);
  vi.mocked(engine.gameUtxoAge).mockResolvedValue(600);
  const both = { ...match, state: { ...match.state, board } };
  expect(await fourk2Actions.collectWait!(rpc, both, match.state.p1)).toBeNull();
  await expect(fourk2Actions.collect!(rpc, both)).rejects.toThrow(/split/);
  expect(engine.pinnedWinner).not.toHaveBeenCalled();
});
