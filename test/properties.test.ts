import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  CELLS,
  COLS,
  MOVE_TIMEOUT_DAA,
  ROWS,
  State,
  cellIndex,
  decodeState,
  discOf,
  encodeState,
  heightOf,
  playerToMove,
  pubkeyOf,
} from "../src/state.js";
import {
  DIRS,
  LineWitness,
  claimDraw,
  claimForfeit,
  move,
  suddenDeath,
  verifyLine,
  winningMove,
} from "../src/rules.js";
import { P1, P2, STAKE, ctx, game } from "./helpers.js";

/**
 * The naive full-board scanner the covenant deliberately does NOT run — here
 * it serves as the oracle the witness scheme is verified against.
 */
function allWinningLines(board: Uint8Array, disc: number): LineWitness[] {
  const wins: LineWitness[] = [];
  for (let col = 0; col < COLS; col++)
    for (let row = 0; row < ROWS; row++)
      for (let dir = 0; dir < DIRS.length; dir++) {
        const [dc, dr] = DIRS[dir]!;
        let ok = true;
        for (let k = 0; k < 4 && ok; k++) {
          const c = col + k * dc;
          const r = row + k * dr;
          ok = c >= 0 && c < COLS && r >= 0 && r < ROWS && board[cellIndex(c, r)] === disc;
        }
        if (ok) wins.push({ col, row, dir });
      }
  return wins;
}

/**
 * Map a seed array to a reachable state by interpreting each seed as an index
 * into the currently non-full columns — every generated game is legal.
 */
function reachableState(seeds: number[]): State {
  let s = game();
  for (const seed of seeds) {
    if (s.moveCount >= CELLS) break;
    const open = [...Array(COLS).keys()].filter((c) => heightOf(s.board, c) < ROWS);
    s = move(s, ctx(pubkeyOf(s, playerToMove(s))), open[seed % open.length]!);
  }
  return s;
}

const arbSeeds = fc.array(fc.nat(6), { maxLength: CELLS });
const arbWitness = fc.record({
  col: fc.integer({ min: -2, max: COLS + 1 }),
  row: fc.integer({ min: -2, max: ROWS + 1 }),
  dir: fc.integer({ min: -1, max: DIRS.length }),
});

describe("invariants over random legal games", () => {
  test("no floating discs, counts consistent, cells well-formed", () => {
    fc.assert(
      fc.property(arbSeeds, (seeds) => {
        const s = reachableState(seeds);
        let discs = 0;
        const perPlayer = [0, 0];
        for (let c = 0; c < COLS; c++) {
          const h = heightOf(s.board, c);
          for (let r = 0; r < ROWS; r++) {
            const cell = s.board[cellIndex(c, r)]!;
            expect([0, 1, 2]).toContain(cell);
            // Gravity: cells below the height are filled, cells above empty.
            expect(cell !== 0).toBe(r < h);
            if (cell !== 0) {
              discs++;
              perPlayer[cell - 1]!++;
            }
          }
        }
        expect(discs).toBe(s.moveCount);
        // P1 moves first, so P1 has equal discs or exactly one more.
        expect(perPlayer[0]! - perPlayer[1]!).toBe(s.moveCount % 2);
      }),
    );
  });

  test("the non-mover is always rejected", () => {
    fc.assert(
      fc.property(arbSeeds, fc.nat(6), (seeds, col) => {
        const s = reachableState(seeds);
        fc.pre(s.moveCount < CELLS);
        const wrong = pubkeyOf(s, (1 - playerToMove(s)) as 0 | 1);
        expect(() => move(s, ctx(wrong), col)).toThrow("not your turn");
      }),
    );
  });

  test("serialization round-trips every reachable state", () => {
    fc.assert(
      fc.property(arbSeeds, (seeds) => {
        const s = reachableState(seeds);
        expect(decodeState(encodeState(s))).toEqual(s);
      }),
    );
  });
});

describe("witness scheme vs the naive oracle", () => {
  test("winningMove accepts a witness iff the oracle confirms that exact line", () => {
    fc.assert(
      fc.property(arbSeeds, fc.nat(6), arbWitness, (seeds, colSeed, w) => {
        const s = reachableState(seeds);
        fc.pre(s.moveCount < CELLS);
        const mover = playerToMove(s);
        const open = [...Array(COLS).keys()].filter((c) => heightOf(s.board, c) < ROWS);
        const col = open[colSeed % open.length]!;
        // Successor board as the covenant would compute it.
        const board = s.board.slice();
        board[cellIndex(col, heightOf(s.board, col))] = discOf(mover);
        const oracleSaysWin = allWinningLines(board, discOf(mover)).some(
          (l) => l.col === w.col && l.row === w.row && l.dir === w.dir,
        );
        const claim = () => winningMove(s, ctx(pubkeyOf(s, mover)), col, w);
        if (oracleSaysWin) {
          expect(claim()).toEqual([{ to: pubkeyOf(s, mover), amount: 2n * STAKE }]);
        } else {
          expect(claim).toThrow("invalid win witness");
        }
      }),
    );
  });

  test("with no real four-in-a-row, EVERY witness fails — cheating is impossible", () => {
    fc.assert(
      fc.property(arbSeeds, fc.nat(6), (seeds, colSeed) => {
        const s = reachableState(seeds);
        fc.pre(s.moveCount < CELLS);
        const mover = playerToMove(s);
        const open = [...Array(COLS).keys()].filter((c) => heightOf(s.board, c) < ROWS);
        const col = open[colSeed % open.length]!;
        const board = s.board.slice();
        board[cellIndex(col, heightOf(s.board, col))] = discOf(mover);
        fc.pre(allWinningLines(board, discOf(mover)).length === 0);
        // Exhaust the entire witness space, not just random samples.
        for (let wc = 0; wc < COLS; wc++)
          for (let wr = 0; wr < ROWS; wr++)
            for (let wd = 0; wd < DIRS.length; wd++) {
              expect(() =>
                winningMove(s, ctx(pubkeyOf(s, mover)), col, { col: wc, row: wr, dir: wd }),
              ).toThrow("invalid win witness");
            }
      }),
      { numRuns: 30 },
    );
  });

  test("verifyLine never reads outside the board", () => {
    fc.assert(
      fc.property(arbWitness, (w) => {
        // A board of all-mover discs: verifyLine may only accept witnesses
        // whose four derived cells are strictly in bounds.
        const board = new Uint8Array(CELLS).fill(1);
        const [dc, dr] = DIRS[w.dir] ?? [0, 0];
        const inBounds =
          DIRS[w.dir] !== undefined &&
          [0, 1, 2, 3].every((k) => {
            const c = w.col + k * dc;
            const r = w.row + k * dr;
            return c >= 0 && c < COLS && r >= 0 && r < ROWS;
          });
        expect(verifyLine(board, 1, w)).toBe(inBounds);
      }),
    );
  });
});

describe("forfeit over random states", () => {
  test("only the waiting player, only after the deadline, only once begun", () => {
    fc.assert(
      fc.property(arbSeeds, fc.integer({ min: 0, max: 2 * MOVE_TIMEOUT_DAA }), (seeds, age) => {
        const s = reachableState(seeds);
        fc.pre(s.moveCount < CELLS);
        const waiting = (1 - playerToMove(s)) as 0 | 1;
        const claim = (signer: string) => () => claimForfeit(s, ctx(signer, age));
        if (s.moveCount === 0) {
          // Unmoved games are dissolvable, never forfeitable — at any age.
          expect(claim(pubkeyOf(s, waiting))).toThrow("dissolve instead");
        } else if (age >= MOVE_TIMEOUT_DAA) {
          expect(claim(pubkeyOf(s, waiting))()).toEqual([
            { to: pubkeyOf(s, waiting), amount: 2n * STAKE },
          ]);
        } else {
          expect(claim(pubkeyOf(s, waiting))).toThrow("deadline not expired");
        }
        // The mover can never claim their own timeout, at any age.
        expect(claim(pubkeyOf(s, playerToMove(s)))).toThrow(
          s.moveCount === 0 ? "dissolve instead" : "waiting player",
        );
      }),
    );
  });
});

describe("liveness: no reachable state can strand the pot", () => {
  test("every reachable state has a PERMISSIONLESS exit once the clocks run out", () => {
    // The guarantee that makes the mandatory join-time deadline sufficient:
    // whatever state a match reaches, a stranger with no key can eventually
    // return the pot to the players — claimDraw on a full board, suddenDeath
    // everywhere else (join refuses deadline == 0, so every reachable state
    // carries one). Signature-holding doors (move, forfeit) don't count here:
    // this is the property that survives BOTH players vanishing.
    fc.assert(
      fc.property(arbSeeds, (seeds) => {
        const s = reachableState(seeds);
        const stranger = "33".repeat(32);
        const exits = [
          () => claimDraw(s, ctx(stranger)),
          () => suddenDeath(s, ctx(stranger, 0, s.deadline)),
        ];
        const payouts = exits.flatMap((exit) => {
          try {
            return [exit()];
          } catch {
            return [];
          }
        });
        expect(payouts.length).toBeGreaterThan(0);
        // And the exit returns the whole pot to the players, nobody else.
        for (const outs of payouts) {
          const total = outs.reduce((sum, o) => sum + o.amount, 0n);
          expect(total).toBe(2n * STAKE);
          for (const o of outs) expect([s.p1, s.p2]).toContain(o.to);
        }
      }),
    );
  });
});
