import { describe, expect, test } from "vitest";
import {
  MIN_MOVE_TIMEOUT_DAA,
  MOVE_TIMEOUT_DAA,
  ZERO_PK,
  cellIndex,
} from "../src/state.js";
import {
  SIMUL_STATE_BYTES,
  ZERO_HASH,
  decodeSimulState,
  encodeSimulState,
  isBoardFull,
  newSimulMatch,
  roundPhase,
} from "../src/simul/state.js";
import {
  cancel,
  claimDraw,
  claimSplit,
  claimTimeout,
  claimWin,
  commit,
  dissolve,
  join,
  resolve,
  reveal,
  splitTimeout,
  suddenDeath,
} from "../src/simul/rules.js";
import { commitmentOf } from "../src/simul/hash.js";
import { P1, P2, STAKE, STRANGER, ctx } from "./helpers.js";
import { commitBoth, playRound, playRounds, salt, simulGame } from "./simul-helpers.js";

const TIMEOUT = MOVE_TIMEOUT_DAA;

/** A posed board from (col, row, disc) triples — the covenant never validates history. */
function posedBoard(cells: Array<[number, number, number]>): Uint8Array {
  const board = new Uint8Array(42);
  for (const [c, r, d] of cells) board[cellIndex(c, r)] = d;
  return board;
}

/** Full column 0: three collision rounds, two discs each. */
function fullColumnGame() {
  return playRounds(simulGame(), [
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
}

describe("open phase", () => {
  test("join then play; joining a joined match fails", () => {
    const s = simulGame();
    expect(s.p2).toBe(P2);
    expect(roundPhase(s)).toBe("commit");
    expect(() => join(s, ctx(STRANGER))).toThrow("match is not open");
  });

  test("join guards: self-join, zero key, trap clock", () => {
    const open = newSimulMatch(P1, STAKE);
    expect(() => join(open, ctx(P1))).toThrow("cannot join your own match");
    expect(() => join(open, ctx(ZERO_PK))).toThrow("invalid joiner pubkey");
    const trap = { ...open, moveTimeout: MIN_MOVE_TIMEOUT_DAA - 1 };
    expect(() => join(trap, ctx(P2))).toThrow("move timeout below minimum");
  });

  test("cancel: p1 only, open only", () => {
    const open = newSimulMatch(P1, STAKE);
    expect(cancel(open, ctx(P1))).toEqual([{ to: P1, amount: STAKE }]);
    expect(() => cancel(open, ctx(P2))).toThrow("only p1 can cancel");
    expect(() => cancel(simulGame(), ctx(P1))).toThrow("match is not open");
  });
});

describe("dissolve", () => {
  test("p1 kicks instantly, p2 waits out the clock", () => {
    const s = simulGame();
    const refund = [
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ];
    expect(dissolve(s, ctx(P1))).toEqual(refund);
    expect(() => dissolve(s, ctx(P2, TIMEOUT - 1))).toThrow("wait out the move clock");
    expect(dissolve(s, ctx(P2, TIMEOUT))).toEqual(refund);
    expect(() => dissolve(s, ctx(STRANGER))).toThrow("only a player can dissolve");
  });

  test("any commitment on the table closes the door", () => {
    const s = commit(simulGame(), ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(() => dissolve(s, ctx(P1))).toThrow("game has begun");
    expect(() => dissolve(s, ctx(P2, TIMEOUT))).toThrow("game has begun");
  });

  test("a completed round closes the door forever", () => {
    const s = playRound(simulGame(), 0, 1);
    expect(() => dissolve(s, ctx(P1))).toThrow("game has begun");
  });
});

describe("commit", () => {
  test("either order; slots are per-player", () => {
    let s = commit(simulGame(), ctx(P2), commitmentOf(4, salt(1, 0)));
    expect(s.commit2).not.toBe(ZERO_HASH);
    expect(s.commit1).toBe(ZERO_HASH);
    expect(roundPhase(s)).toBe("commit");
    s = commit(s, ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(roundPhase(s)).toBe("reveal");
  });

  test("double commit, stranger, zero and malformed hashes rejected", () => {
    const s = commit(simulGame(), ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(() => commit(s, ctx(P1), commitmentOf(4, salt(0, 0)))).toThrow("already committed");
    expect(() => commit(s, ctx(STRANGER), commitmentOf(0, salt(0, 0)))).toThrow(
      "only a player may act",
    );
    expect(() => commit(simulGame(), ctx(P1), ZERO_HASH)).toThrow("invalid commitment");
    expect(() => commit(simulGame(), ctx(P1), "beef")).toThrow("invalid commitment");
  });

  test("closed after a reveal, refused on a full board, refused while open", () => {
    let s = commitBoth(simulGame(), 2, 5);
    s = reveal(s, ctx(P1), 2, salt(0, 0));
    expect(() => commit(s, ctx(P2), commitmentOf(1, salt(1, 0)))).toThrow("commit phase is over");
    const full = { ...simulGame(), board: new Uint8Array(42).fill(1) };
    expect(() => commit(full, ctx(P1), commitmentOf(0, salt(0, 0)))).toThrow(
      "board full — claim the draw instead",
    );
    expect(() => commit(newSimulMatch(P1, STAKE), ctx(P1), commitmentOf(0, salt(0, 0)))).toThrow(
      "match not started",
    );
  });

  test("DOCUMENTED EDGE: copying the opponent's hash is a blind collision, not an attack", () => {
    // P2 mirrors P1's visible commitment byte-for-byte. Their reveal must
    // then be P1's exact column AND salt — a same-column round they chose
    // without knowing the column. The round resolves as a normal collision.
    const h = commitmentOf(3, salt(0, 0));
    let s = commit(simulGame(), ctx(P1), h);
    s = commit(s, ctx(P2), h);
    s = reveal(s, ctx(P1), 3, salt(0, 0));
    s = resolve(s, ctx(P2), 3, salt(0, 0));
    expect(s.board[cellIndex(3, 0)]).toBe(1); // round 0 priority: p1 lower
    expect(s.board[cellIndex(3, 1)]).toBe(2);
  });
});

describe("reveal and resolve", () => {
  test("a full round in both reveal orders", () => {
    for (const first of [0, 1] as const) {
      const s = playRound(simulGame(), 2, 5, first);
      expect(s.round).toBe(1);
      expect(roundPhase(s)).toBe("commit");
      expect(s.board[cellIndex(2, 0)]).toBe(1);
      expect(s.board[cellIndex(5, 0)]).toBe(2);
      expect(s.commit1).toBe(ZERO_HASH);
      expect(s.reveal1).toBe(0);
    }
  });

  test("reveal needs both commitments; a second reveal must resolve", () => {
    const one = commit(simulGame(), ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(() => reveal(one, ctx(P1), 3, salt(0, 0))).toThrow("commit phase not complete");
    let s = commitBoth(simulGame(), 3, 4);
    s = reveal(s, ctx(P1), 3, salt(0, 0));
    expect(roundPhase(s)).toBe("resolve");
    expect(s.commit1).toBe(ZERO_HASH); // revealer's slot zeroed
    expect(s.reveal1).toBe(4); // column + 1
    expect(() => reveal(s, ctx(P2), 4, salt(1, 0))).toThrow("resolve instead");
  });

  test("wrong column or salt is rejected at both doors", () => {
    let s = commitBoth(simulGame(), 3, 4);
    expect(() => reveal(s, ctx(P1), 4, salt(0, 0))).toThrow("wrong column or salt");
    expect(() => reveal(s, ctx(P1), 3, salt(0, 1))).toThrow("wrong column or salt");
    s = reveal(s, ctx(P1), 3, salt(0, 0));
    expect(() => resolve(s, ctx(P2), 5, salt(1, 0))).toThrow("wrong column or salt");
  });

  test("resolve guards: nothing to resolve, already revealed, out-of-range column", () => {
    const fresh = commitBoth(simulGame(), 3, 4);
    expect(() => resolve(fresh, ctx(P1), 3, salt(0, 0))).toThrow("nothing to resolve");
    const half = reveal(fresh, ctx(P1), 3, salt(0, 0));
    expect(() => resolve(half, ctx(P1), 3, salt(0, 0))).toThrow("you already revealed");
    expect(() => reveal(commitBoth(simulGame(), 3, 4), ctx(P1), 9, salt(0, 0))).toThrow(
      "column out of range",
    );
  });

  test("a full-column commitment can never be revealed", () => {
    const s = commitBoth(fullColumnGame(), 0, 1);
    // P1 sealed column 0, which was already full when they committed.
    expect(() => reveal(s, ctx(P1), 0, salt(0, 3))).toThrow("column full");
    // The resolver is held to the same board: P2 reveals fine, P1 cannot resolve.
    const half = reveal(s, ctx(P2), 1, salt(1, 3));
    expect(() => resolve(half, ctx(P1), 0, salt(0, 3))).toThrow("column full");
  });

  test("collision priority alternates by round", () => {
    let s = playRound(simulGame(), 3, 3); // round 0: p1 lands lower
    expect(s.board[cellIndex(3, 0)]).toBe(1);
    expect(s.board[cellIndex(3, 1)]).toBe(2);
    s = playRound(s, 3, 3); // round 1: p2 lands lower
    expect(s.board[cellIndex(3, 2)]).toBe(2);
    expect(s.board[cellIndex(3, 3)]).toBe(1);
  });

  test("DOCUMENTED EDGE: colliding on a column's last slot drops only the priority disc", () => {
    // Two collision rounds put 4 discs in column 0; round 2 adds p1's fifth.
    let s = playRounds(simulGame(), [
      [0, 0],
      [0, 0],
    ]);
    s = playRound(s, 0, 1);
    // Round 3, priority p2: both pick column 0's single free slot.
    s = playRound(s, 0, 0);
    expect(s.board[cellIndex(0, 5)]).toBe(2); // p2's disc survives
    let discs = 0;
    for (const b of s.board) if (b !== 0) discs++;
    expect(discs).toBe(7); // 8 dropped, 1 vanished
  });
});

describe("claim_win", () => {
  /** P1 builds a bottom-row line across columns 0..3; P2 stacks harmlessly. */
  function p1WinGame() {
    return playRounds(simulGame(), [
      [0, 5],
      [1, 6],
      [2, 5],
      [3, 6],
    ]);
  }

  test("the line's owner takes the pot — even though the opponent resolved", () => {
    const s = p1WinGame();
    expect(claimWin(s, ctx(P1), { col: 0, row: 0, dir: 0 })).toEqual([
      { to: P1, amount: 2n * STAKE },
    ]);
  });

  test("only the owner: opponent and stranger are rejected on a real line", () => {
    const s = p1WinGame();
    expect(() => claimWin(s, ctx(P2), { col: 0, row: 0, dir: 0 })).toThrow("not your line");
    expect(() => claimWin(s, ctx(STRANGER), { col: 0, row: 0, dir: 0 })).toThrow("not your line");
  });

  test("bogus witnesses: empty first cell, broken line, out of bounds", () => {
    const s = p1WinGame();
    expect(() => claimWin(s, ctx(P1), { col: 0, row: 5, dir: 0 })).toThrow("invalid win witness");
    expect(() => claimWin(s, ctx(P2), { col: 5, row: 0, dir: 1 })).toThrow("invalid win witness");
    expect(() => claimWin(s, ctx(P1), { col: 6, row: 0, dir: 0 })).toThrow("invalid win witness");
    expect(() => claimWin(s, ctx(P1), { col: 0, row: 0, dir: 7 })).toThrow("invalid win witness");
  });

  test("an unclaimed win survives later rounds and stays claimable", () => {
    const s = playRound(p1WinGame(), 4, 5);
    expect(claimWin(s, ctx(P1), { col: 0, row: 0, dir: 0 })).toEqual([
      { to: P1, amount: 2n * STAKE },
    ]);
  });
});

describe("claim_split — the double win", () => {
  const doubleBoard = posedBoard([
    // P1's line on row 0, P2's directly above on row 1 — gravity-consistent.
    [0, 0, 1],
    [1, 0, 1],
    [2, 0, 1],
    [3, 0, 1],
    [0, 1, 2],
    [1, 1, 2],
    [2, 1, 2],
    [3, 1, 2],
  ]);

  test("two lines, one per color, split the pot — anyone may crank", () => {
    const s = { ...simulGame(), board: doubleBoard };
    const w1 = { col: 0, row: 0, dir: 0 };
    const w2 = { col: 0, row: 1, dir: 0 };
    for (const signer of [P1, P2, STRANGER]) {
      expect(claimSplit(s, ctx(signer), w1, w2)).toEqual([
        { to: P1, amount: STAKE },
        { to: P2, amount: STAKE },
      ]);
    }
  });

  test("both witnesses must verify, in their fixed color order", () => {
    const s = { ...simulGame(), board: doubleBoard };
    const w1 = { col: 0, row: 0, dir: 0 };
    const w2 = { col: 0, row: 1, dir: 0 };
    expect(() => claimSplit(s, ctx(P1), w2, w1)).toThrow("invalid split witnesses");
    expect(() => claimSplit(s, ctx(P1), w1, { col: 0, row: 2, dir: 0 })).toThrow(
      "invalid split witnesses",
    );
    const single = playRounds(simulGame(), [
      [0, 5],
      [1, 6],
      [2, 5],
      [3, 6],
    ]);
    expect(() => claimSplit(single, ctx(P1), w1, w2)).toThrow("invalid split witnesses");
  });
});

describe("draw", () => {
  test("full board splits, permissionless; anything less is rejected", () => {
    const full = new Uint8Array(42);
    for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) full[cellIndex(c, r)] = ((c + r) % 2) + 1;
    expect(isBoardFull(full)).toBe(true);
    const s = { ...simulGame(), board: full };
    expect(claimDraw(s, ctx(STRANGER))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
    expect(() => claimDraw(simulGame(), ctx(P1))).toThrow("board not full");
  });
});

describe("claim_timeout — one-sided lateness", () => {
  test("lone committer claims once the clock lapses", () => {
    for (const player of [0, 1] as const) {
      const pk = player === 0 ? P1 : P2;
      const s = commit(simulGame(), ctx(pk), commitmentOf(3, salt(player, 0)));
      expect(() => claimTimeout(s, ctx(pk, TIMEOUT - 1))).toThrow("deadline not expired");
      expect(claimTimeout(s, ctx(pk, TIMEOUT))).toEqual([{ to: pk, amount: 2n * STAKE }]);
      const other = player === 0 ? P2 : P1;
      expect(() => claimTimeout(s, ctx(other, TIMEOUT))).toThrow("compliant player");
    }
  });

  test("lone revealer claims — this is what punishes peek-then-stall", () => {
    for (const first of [0, 1] as const) {
      const round0 = commitBoth(simulGame(), 2, 5);
      const pk = first === 0 ? P1 : P2;
      const col = first === 0 ? 2 : 5;
      const s = reveal(round0, ctx(pk), col, salt(first, 0));
      expect(claimTimeout(s, ctx(pk, TIMEOUT))).toEqual([{ to: pk, amount: 2n * STAKE }]);
      const staller = first === 0 ? P2 : P1;
      expect(() => claimTimeout(s, ctx(staller, TIMEOUT))).toThrow("compliant player");
    }
  });

  test("symmetric states and full boards belong to other doors", () => {
    expect(() => claimTimeout(simulGame(), ctx(P1, TIMEOUT))).toThrow("split instead");
    const both = commitBoth(simulGame(), 2, 5);
    expect(() => claimTimeout(both, ctx(P1, TIMEOUT))).toThrow("split instead");
    const full = {
      ...simulGame(),
      board: new Uint8Array(42).fill(1),
      commit1: commitmentOf(0, salt(0, 0)),
    };
    expect(() => claimTimeout(full, ctx(P1, TIMEOUT))).toThrow("claim the draw instead");
  });
});

describe("split_timeout — symmetric stalls", () => {
  test("neither committed, or both sealed and neither revealed", () => {
    const refund = [
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ];
    expect(splitTimeout(simulGame(), ctx(STRANGER, TIMEOUT))).toEqual(refund);
    const both = commitBoth(simulGame(), 2, 5);
    expect(splitTimeout(both, ctx(STRANGER, TIMEOUT))).toEqual(refund);
    expect(() => splitTimeout(both, ctx(P1, TIMEOUT - 1))).toThrow("deadline not expired");
  });

  test("one-sided states are refused — the compliant player must not be robbed of the pot", () => {
    const one = commit(simulGame(), ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(() => splitTimeout(one, ctx(P2, TIMEOUT))).toThrow("claim the forfeit instead");
    const half = reveal(commitBoth(simulGame(), 2, 5), ctx(P1), 2, salt(0, 0));
    expect(() => splitTimeout(half, ctx(P2, TIMEOUT))).toThrow("claim the forfeit instead");
  });
});

describe("sudden death", () => {
  test("mirrors classic: permissionless even split at the cap, any live state", () => {
    const s = { ...playRound(simulGame(), 2, 5), deadline: 1000 };
    expect(suddenDeath(s, ctx(STRANGER, 0, 1000))).toEqual([
      { to: P1, amount: STAKE },
      { to: P2, amount: STAKE },
    ]);
    expect(() => suddenDeath(s, ctx(STRANGER, 0, 999))).toThrow("deadline not reached");
    expect(() => suddenDeath(playRound(simulGame(), 2, 5), ctx(P1, 0, 1e9))).toThrow(
      "no game deadline set",
    );
  });
});

describe("canonical serialization", () => {
  test("round-trips every sub-phase, including mid-round slots", () => {
    let s = simulGame();
    expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
    s = commit(s, ctx(P1), commitmentOf(3, salt(0, 0)));
    expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
    s = commit(s, ctx(P2), commitmentOf(4, salt(1, 0)));
    expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
    s = reveal(s, ctx(P2), 4, salt(1, 0));
    expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
    s = resolve(s, ctx(P1), 3, salt(0, 0));
    expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
  });

  test("rejects bad lengths, cells, and reveal values", () => {
    expect(() => decodeSimulState(new Uint8Array(SIMUL_STATE_BYTES - 1))).toThrow(
      "bad state length",
    );
    const bad = encodeSimulState(simulGame());
    bad[0] = 3;
    expect(() => decodeSimulState(bad)).toThrow("bad cell value");
    const badReveal = encodeSimulState(simulGame());
    badReveal[42 + 129] = 8; // reveal1 = column 7 + 1 — out of range
    expect(() => decodeSimulState(badReveal)).toThrow("bad reveal value");
  });
});
