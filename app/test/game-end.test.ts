import { expect, test } from "vitest";
import { gameEnd } from "../src/shared/lib/result";
import { FREE_STAKE, type Match } from "../src/shared/lib/match";
import { ZERO_CORE } from "../src/shared/modes/fourk/core";

const match: Match = {
  network: "testnet-10",
  mode: "fourk",
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
  simul: { ...ZERO_CORE, pendingWin: 1 },
};
const money = /\b(pot|stake|payout|refund|balance|fee|winnings)\b/i;

test("a decided board shows both results without marking settlement complete", () => {
  expect(gameEnd(match, match.state.p1)).toMatchObject({
    title: "You win!",
    tone: "win",
    settling: true,
  });
  expect(gameEnd(match, match.state.p2)).toMatchObject({
    title: "You lose",
    tone: "loss",
    settling: true,
  });
  expect(gameEnd(match, "spectator")).toMatchObject({ title: "Red wins!", tone: "neutral" });
  expect(match.result).toBeUndefined();
  expect(gameEnd({ ...match, simul: { ...ZERO_CORE } }, match.state.p1)?.title).toBe("You win!");
});

test("P2 wins, color overrides, and a second line are classified correctly", () => {
  const p2 = {
    ...match,
    p1Color: "blue" as const,
    state: { ...match.state, board: Uint8Array.from([2, 2, 2, 2, ...Array(38).fill(0)]) },
  };
  expect(gameEnd(p2, p2.state.p2)?.title).toBe("You win!");
  expect(gameEnd(p2, p2.state.p1)?.title).toBe("You lose");
  expect(gameEnd(p2, "spectator")?.title).toBe("Red wins!");
  const both = {
    ...match,
    state: {
      ...match.state,
      board: Uint8Array.from([1, 1, 1, 1, 0, 0, 2, 2, 2, 2, ...Array(32).fill(0)]),
    },
  };
  expect(gameEnd(both, both.state.p1)).toMatchObject({ title: "It's a draw!", tone: "neutral" });
});

test("a pending claim without a winning board is not enough to declare victory", () => {
  expect(
    gameEnd({ ...match, state: { ...match.state, board: new Uint8Array(42) } }, match.state.p1),
  ).toBeNull();
});

test.each([
  ["You both connected four in the same drop — the pot split evenly.", "It's a draw!"],
  ["The game stalled on both sides — it timed out and the pot split evenly.", "It's a draw!"],
  ["Time's up — the game hit its total time limit and the pot split evenly.", "It's a draw!"],
  ["The round timer ran out and your opponent claimed the pot.", "You lose"],
  ["The game was dissolved — both stakes returned.", "Game cancelled"],
  ["Your opponent left before the game began — your stake is on its way back.", "Game cancelled"],
  ["You connected four — you win! 🎉", "You win!"],
  ["Time's up — the game hit its total time limit and the winner took the pot.", "You win!"],
])("old stored result is presented without money: %s", (result, title) => {
  const ending = gameEnd(match, match.state.p1, result)!;
  expect(ending.title).toBe(title);
  expect(ending.message).not.toMatch(money);
  expect(ending.settling).toBe(false);
});

test("network reset overrides the board, and staked wins are not called paid early", () => {
  expect(gameEnd(match, match.state.p1, "The test network was reset.")).toMatchObject({
    title: "Game over",
    tone: "neutral",
  });
  const paid = { ...match, state: { ...match.state, stake: 100_000_000n } };
  expect(gameEnd(paid, paid.state.p1)).toMatchObject({ settling: true, tone: "win" });
});

test("unknown saved endings do not reintroduce old punctuation or emojis", () => {
  const ending = gameEnd(match, match.state.p1, "The game ended — reconnect later. 🎉")!;
  expect(ending.message).toBe("The game ended. Reconnect later.");
});
