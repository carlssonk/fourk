import { describe, expect, test } from "vitest";
import {
  MIN_MOVE_TIMEOUT_DAA,
  MOVE_TIMEOUT_DAA,
  ZERO_PK,
  cellIndex,
  decodeState,
  encodeState,
  newMatch,
} from "../src/state.js";
import {
  cancel,
  claimDraw,
  claimForfeit,
  dissolve,
  join,
  move,
  suddenDeath,
  winningMove,
} from "../src/rules.js";
import { P1, P2, STAKE, STRANGER, ctx, fillBoard, game, play } from "./helpers.js";

describe("open phase", () => {
  test("join sets p2 and preserves everything else", () => {
    const s = join(newMatch(P1, STAKE), ctx(P2));
    expect(s.p2).toBe(P2);
    expect(s.p1).toBe(P1);
    expect(s.moveCount).toBe(0);
    expect(s.board.every((b) => b === 0)).toBe(true);
  });

  test("cannot join a match twice", () => {
    expect(() => join(game(), ctx(STRANGER))).toThrow("not open");
  });

  test("joining with the zero pubkey fails", () => {
    expect(() => join(newMatch(P1, STAKE), ctx(ZERO_PK))).toThrow("invalid joiner");
  });

  test("p1 cannot join their own match", () => {
    expect(() => join(newMatch(P1, STAKE), ctx(P1))).toThrow("cannot join your own match");
  });

  test("p1 can cancel an open match and reclaim the stake", () => {
    expect(cancel(newMatch(P1, STAKE), ctx(P1))).toEqual([{ to: P1, amount: STAKE }]);
  });

  test("nobody else can cancel", () => {
    expect(() => cancel(newMatch(P1, STAKE), ctx(STRANGER))).toThrow("only p1");
  });

  test("cannot cancel after a join", () => {
    expect(() => cancel(game(), ctx(P1))).toThrow("not open");
  });

  test("cannot move, draw, forfeit, or dissolve before a join", () => {
    const s = newMatch(P1, STAKE);
    expect(() => move(s, ctx(P1), 0)).toThrow("not started");
    expect(() => claimDraw(s, ctx(P1))).toThrow("not started");
    expect(() => claimForfeit(s, ctx(P1, MOVE_TIMEOUT_DAA))).toThrow("not started");
    expect(() => dissolve(s, ctx(P1))).toThrow("not started");
  });

  test("match creation rejects bad stakes, pubkeys, and timing", () => {
    expect(() => newMatch(P1, 0n)).toThrow("stake");
    expect(() => newMatch(P1, -1n)).toThrow("stake");
    expect(() => newMatch(ZERO_PK, STAKE)).toThrow("pubkey");
    expect(() => newMatch("nonsense", STAKE)).toThrow("pubkey");
    expect(() => newMatch(P1, STAKE, MIN_MOVE_TIMEOUT_DAA - 1)).toThrow("timeout");
    expect(() => newMatch(P1, STAKE, MOVE_TIMEOUT_DAA, -1)).toThrow("deadline");
  });

  test("a trap genesis with a below-floor move timeout is unjoinable", () => {
    const trap = { ...newMatch(P1, STAKE), moveTimeout: MIN_MOVE_TIMEOUT_DAA - 1 };
    expect(() => join(trap, ctx(P2))).toThrow("timeout below minimum");
    expect(join({ ...trap, moveTimeout: MIN_MOVE_TIMEOUT_DAA }, ctx(P2)).p2).toBe(P2);
  });
});

describe("dissolve", () => {
  test("p1 can kick the joiner before the first disc — both stakes return", () => {
    expect(dissolve(game(), ctx(P1))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
  });

  test("p2 can leave an unstarted lobby after one move clock — both stakes return", () => {
    expect(dissolve(game(), ctx(P2, MOVE_TIMEOUT_DAA))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
  });

  test("p2 cannot join-and-run — the exit waits out the move clock", () => {
    expect(() => dissolve(game(), ctx(P2))).toThrow("wait out the move clock");
    expect(() => dissolve(game(), ctx(P2, MOVE_TIMEOUT_DAA - 1))).toThrow(
      "wait out the move clock",
    );
  });

  test("p1's kick needs no waiting", () => {
    expect(dissolve(game(), ctx(P1, 0))).toHaveLength(2);
  });

  test("a stranger cannot dissolve", () => {
    expect(() => dissolve(game(), ctx(STRANGER))).toThrow("only a player");
  });

  test("cannot dissolve once a disc has fallen", () => {
    const s = play(game(), [3]);
    expect(() => dissolve(s, ctx(P1))).toThrow("game has begun");
    expect(() => dissolve(s, ctx(P2))).toThrow("game has begun");
  });
});

describe("moves", () => {
  test("discs land with gravity and alternate turns", () => {
    const s = play(game(), [3, 3, 3]);
    expect(s.board[cellIndex(3, 0)]).toBe(1);
    expect(s.board[cellIndex(3, 1)]).toBe(2);
    expect(s.board[cellIndex(3, 2)]).toBe(1);
    expect(s.moveCount).toBe(3);
  });

  test("moving out of turn fails", () => {
    expect(() => move(game(), ctx(P2), 0)).toThrow("not your turn");
    const s = move(game(), ctx(P1), 0);
    expect(() => move(s, ctx(P1), 1)).toThrow("not your turn");
  });

  test("a non-player cannot move", () => {
    expect(() => move(game(), ctx(STRANGER), 0)).toThrow("not your turn");
  });

  test.each([-1, 7, 3.5, NaN])("column %s is rejected", (col) => {
    expect(() => move(game(), ctx(P1), col)).toThrow("column out of range");
  });

  test("moving in a full column fails", () => {
    const s = play(game(), [0, 0, 0, 0, 0, 0]);
    expect(() => move(s, ctx(P1), 0)).toThrow("column full");
  });

  test("no moves on a full board", () => {
    expect(() => move(fillBoard(game()), ctx(P1), 0)).toThrow("board full");
  });
});

describe("winning move", () => {
  test("vertical win pays the pot", () => {
    const s = play(game(), [0, 1, 0, 1, 0, 1]);
    const out = winningMove(s, ctx(P1), 0, { col: 0, row: 0, dir: 1 });
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("horizontal win pays the pot", () => {
    const s = play(game(), [0, 6, 1, 6, 2, 6]);
    const out = winningMove(s, ctx(P1), 3, { col: 0, row: 0, dir: 0 });
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("NE diagonal win pays the pot", () => {
    const s = play(game(), [0, 1, 1, 2, 2, 3, 2, 3, 3, 5]);
    const out = winningMove(s, ctx(P1), 3, { col: 0, row: 0, dir: 2 });
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("SE diagonal win pays the pot", () => {
    const s = play(game(), [3, 2, 2, 1, 1, 0, 1, 0, 0, 5]);
    const out = winningMove(s, ctx(P1), 0, { col: 0, row: 3, dir: 3 });
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("p2 can win too", () => {
    const s = play(game(), [6, 0, 5, 0, 4, 0, 6]);
    const out = winningMove(s, ctx(P2), 0, { col: 0, row: 0, dir: 1 });
    expect(out).toEqual([{ to: P2, amount: 2n * STAKE }]);
  });

  test("an unclaimed win can be claimed on a later turn", () => {
    // P1 completes a vertical four with a plain move (no claim)...
    const s = play(game(), [0, 1, 0, 1, 0, 1, 0, 2]);
    // ...and claims the old line while dropping an unrelated disc.
    const out = winningMove(s, ctx(P1), 5, { col: 0, row: 0, dir: 1 });
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("claiming the opponent's line fails: cells hold the wrong color", () => {
    // P2 quietly builds an unclaimed vertical four in column 6.
    const s = play(game(), [0, 6, 1, 6, 2, 6, 4, 6]);
    expect(() => winningMove(s, ctx(P1), 5, { col: 6, row: 0, dir: 1 })).toThrow(
      "invalid win witness",
    );
  });

  test("a line through empty cells fails", () => {
    const s = play(game(), [0, 1]);
    expect(() => winningMove(s, ctx(P1), 0, { col: 0, row: 0, dir: 1 })).toThrow(
      "invalid win witness",
    );
  });

  test.each([
    [{ col: 4, row: 0, dir: 0 }], // runs off the right edge
    [{ col: 0, row: 3, dir: 1 }], // runs off the top
    [{ col: 0, row: 2, dir: 3 }], // runs below the floor
    [{ col: -1, row: 0, dir: 0 }],
    [{ col: 0, row: 0, dir: 4 }], // no such direction
    [{ col: 0, row: 0, dir: -1 }],
    [{ col: 0.5, row: 0, dir: 0 }],
  ])("out-of-bounds or malformed witness %j fails", (w) => {
    // Board state is irrelevant: even a board covered in P1 discs must reject these.
    const s = play(game(), [0, 1, 0, 1, 0, 1]);
    expect(() => winningMove(s, ctx(P1), 0, w)).toThrow("invalid win witness");
  });

  test("winningMove still enforces move legality", () => {
    const s = play(game(), [0, 1, 0, 1, 0, 1]);
    const w = { col: 0, row: 0, dir: 1 };
    expect(() => winningMove(s, ctx(P2), 0, w)).toThrow("not your turn");
    expect(() => winningMove(s, ctx(P1), 9, w)).toThrow("column out of range");
    // Fill column 0 to the brim; P2 even holds a real (unclaimed) vertical
    // four in column 1 — the full-column check must still reject the move.
    const full = play(s, [0, 1, 0, 2, 0]);
    expect(() => winningMove(full, ctx(P2), 0, { col: 1, row: 0, dir: 1 })).toThrow(
      "column full",
    );
  });
});

describe("draw", () => {
  test("claiming a draw before the board is full fails", () => {
    expect(() => claimDraw(game(), ctx(P1))).toThrow("board not full");
    expect(() => claimDraw(play(game(), [0, 1, 2]), ctx(P1))).toThrow("board not full");
  });

  test("full board splits the pot, and anyone may crank it", () => {
    const s = fillBoard(game());
    expect(claimDraw(s, ctx(STRANGER))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
  });

  test("DOCUMENTED EDGE: an unclaimed win on a full board is lost to the draw", () => {
    // fillBoard gives P1 a horizontal line on row 0 that was never claimed.
    // The covenant cannot see it (no board scan by design); P1 had 21 turns to
    // claim via winningMove and declined every time.
    const s = fillBoard(game());
    expect(claimDraw(s, ctx(P2))).toHaveLength(2);
  });
});

describe("forfeit", () => {
  test("waiting player takes the pot after the timeout", () => {
    const s = play(game(), [0]); // P2 to move, P1 waiting
    const out = claimForfeit(s, ctx(P1, MOVE_TIMEOUT_DAA));
    expect(out).toEqual([{ to: P1, amount: 2n * STAKE }]);
  });

  test("cannot claim before the deadline", () => {
    const s = play(game(), [0]);
    expect(() => claimForfeit(s, ctx(P1, MOVE_TIMEOUT_DAA - 1))).toThrow(
      "deadline not expired",
    );
  });

  test("the player to move cannot forfeit the opponent", () => {
    const s = play(game(), [0]); // it is P2's turn
    expect(() => claimForfeit(s, ctx(P2, MOVE_TIMEOUT_DAA))).toThrow("waiting player");
  });

  test("a stranger cannot claim", () => {
    const s = play(game(), [0]);
    expect(() => claimForfeit(s, ctx(STRANGER, MOVE_TIMEOUT_DAA))).toThrow(
      "waiting player",
    );
  });

  test("no forfeit on a full board — that is the draw's door", () => {
    const s = fillBoard(game());
    expect(() => claimForfeit(s, ctx(P1, MOVE_TIMEOUT_DAA))).toThrow("board full");
  });

  test("no forfeit before the first disc — an unmoved game is dissolved, not seized", () => {
    const s = game(); // moveCount 0: P1 may not even know the join happened
    expect(() => claimForfeit(s, ctx(P2, MOVE_TIMEOUT_DAA))).toThrow("dissolve instead");
  });

  test("the per-match timeout is the one enforced, not the default", () => {
    const blitz = play({ ...game(), moveTimeout: MIN_MOVE_TIMEOUT_DAA }, [0]);
    expect(claimForfeit(blitz, ctx(P1, MIN_MOVE_TIMEOUT_DAA))).toEqual([
      { to: P1, amount: 2n * STAKE },
    ]);
    expect(() => claimForfeit(blitz, ctx(P1, MIN_MOVE_TIMEOUT_DAA - 1))).toThrow(
      "deadline not expired",
    );
  });
});

describe("sudden death", () => {
  const DEADLINE = 1_000_000;
  const capped = () => ({ ...game(), deadline: DEADLINE });

  test("past the deadline the pot splits, and anyone may crank it", () => {
    const s = play(capped(), [0, 1, 2]);
    expect(suddenDeath(s, ctx(STRANGER, 0, DEADLINE))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
  });

  test("legal even on an unmoved board — cleanup for abandoned lobbies", () => {
    expect(suddenDeath(capped(), ctx(STRANGER, 0, DEADLINE + 5))).toHaveLength(2);
  });

  test("cannot claim before the deadline", () => {
    expect(() => suddenDeath(capped(), ctx(P1, 0, DEADLINE - 1))).toThrow("not reached");
  });

  test("uncapped games have no sudden death", () => {
    expect(() => suddenDeath(game(), ctx(P1, 0, Number.MAX_SAFE_INTEGER))).toThrow(
      "no game deadline",
    );
  });

  test("open matches cannot sudden-death (cancel covers them)", () => {
    const s = { ...newMatch(P1, STAKE), deadline: DEADLINE };
    expect(() => suddenDeath(s, ctx(P1, 0, DEADLINE))).toThrow("not started");
  });
});

describe("canonical serialization", () => {
  test("round-trips a mid-game state", () => {
    const s = play(game(), [3, 3, 0, 6, 1]);
    expect(decodeState(encodeState(s))).toEqual(s);
  });

  test("rejects wrong length and corrupt cells", () => {
    const buf = encodeState(game());
    expect(() => decodeState(buf.slice(1))).toThrow("bad state length");
    const corrupt = buf.slice();
    corrupt[0] = 7;
    expect(() => decodeState(corrupt)).toThrow("bad cell value");
  });
});
