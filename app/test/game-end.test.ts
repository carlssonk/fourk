import { expect, test } from "vitest";
import { gameEnd } from "../src/shared/lib/result";
import { FREE_STAKE, fromHex, type Match } from "../src/shared/lib/match";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";
import { describeSharedEnd } from "../src/shared/modes/common";
import type { SpendInfo } from "../src/shared/lib/engine";

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
  expect(gameEnd({ ...match, simul: zeroCore2(600) }, match.state.p1)?.title).toBe("You win!");
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

// Every ending the current modes write, each with the title it must read as.
// Refund endings mention the split too, so a classifier that tests "split"
// first once called a refunded first round "It's a draw! The board is full."
test.each([
  [
    "The second pick never landed. The game was called off and the pot split evenly.",
    "Game called off",
    "The second pick never arrived, so nobody won or lost.",
  ],
  [
    "The second pick arrived after the deadline. The game was called off and the pot split evenly.",
    "Game called off",
    "The second pick arrived too late, so nobody won or lost.",
  ],
  [
    "Neither player picked before the timer ended. The pot split evenly.",
    "It's a draw!",
    "Neither player picked in time.",
  ],
  [
    "The game stalled on both sides. It timed out and the pot split evenly.",
    "It's a draw!",
    "Neither player revealed in time.",
  ],
  [
    "Time's up. The game hit its total time limit and the pot split evenly.",
    "It's a draw!",
    "The game reached its time limit.",
  ],
  [
    "Time's up. The game hit its total time limit and you took the pot.",
    "You win!",
    "Your opponent ran out of time.",
  ],
  [
    "Time's up. The game hit its total time limit and your opponent took the pot.",
    "You lose",
    "You ran out of time.",
  ],
  ["It's a draw. The board filled up with no winner.", "It's a draw!", "The board is full."],
  [
    "You both connected four in the same drop. The pot split evenly.",
    "It's a draw!",
    "You both connected four in the same round.",
  ],
  [
    "The game was called off before anyone joined.",
    "Game cancelled",
    "This game ended before the first move.",
  ],
  [
    "Your opponent ran out of time. You win by timeout.",
    "You win!",
    "Your opponent ran out of time.",
  ],
  ["The pick timer ran out and your opponent claimed the pot.", "You lose", "You ran out of time."],
])("current ending reads right: %s", (result, title, message) => {
  const ending = gameEnd(
    { ...match, state: { ...match.state, board: new Uint8Array(42) } },
    match.state.p1,
    result,
  )!;
  expect(ending.title).toBe(title);
  expect(ending.message).toBe(message);
  expect(ending.message).not.toMatch(money);
});

test("every lobby-exit ending reads as a cancelled game, whoever left", () => {
  const lobby: Match = {
    ...match,
    state: { ...match.state, board: new Uint8Array(42), moveCount: 0 },
    simul: zeroCore2(600),
  };
  const [p1, p2] = [lobby.state.p1, lobby.state.p2];
  for (const [by, me] of [
    [p1, p2], // the host left: the joiner's view
    [p2, p1], // the joiner left: the host's view
    [p1, p1], // our own exit
    [p2, ""], // a spectator
  ] as const) {
    const spend = { kind: "dissolve", pushes: [new Uint8Array(64), fromHex(by)] };
    const told = describeSharedEnd(spend as SpendInfo, lobby, me)!;
    expect(gameEnd({ ...lobby, result: told }, me), told).toMatchObject({
      title: "Game cancelled",
      message: "This game ended before the first move.",
    });
  }
});
