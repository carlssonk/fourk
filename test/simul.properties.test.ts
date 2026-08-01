import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { COLS, ROWS, cellIndex, discOf, heightOf } from "../src/state.js";
import { DIRS, LineWitness } from "../src/rules.js";
import {
  SimulState,
  ZERO_HASH,
  decodeSimulState,
  encodeSimulState,
  isBoardFull,
  priorityPlayer,
  roundPhase,
} from "../src/simul/state.js";
import { claimWin, commit, legalSimulColumns, resolve, reveal } from "../src/simul/rules.js";
import { commitmentOf } from "../src/simul/hash.js";
import { P1, P2, STAKE, STRANGER, ctx } from "./helpers.js";
import { pkOf, salt, simulGame } from "./simul-helpers.js";

/** The naive scanner (same oracle as the classic property suite). */
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

type RoundSeed = [number, number, number];

/**
 * Map seed triples [p1Pick, p2Pick, revealOrder] onto full legal rounds —
 * both picks drawn from the currently non-full columns, so every generated
 * game is legal by construction. Vanished discs are tracked per player: they
 * are exactly what breaks the classic disc-count identities.
 */
function reachableSimul(seeds: RoundSeed[]): { s: SimulState; vanished: [number, number] } {
  let s = simulGame();
  const vanished: [number, number] = [0, 0];
  for (const [aSeed, bSeed, order] of seeds) {
    if (isBoardFull(s.board)) break;
    const open = legalSimulColumns(s);
    const a = open[aSeed % open.length]!;
    const b = open[bSeed % open.length]!;
    if (a === b && heightOf(s.board, a) === ROWS - 1) {
      vanished[(1 - priorityPlayer(s.round)) as 0 | 1]++;
    }
    const round = s.round;
    s = commit(s, ctx(P1), commitmentOf(a, salt(0, round)));
    s = commit(s, ctx(P2), commitmentOf(b, salt(1, round)));
    const first = (order % 2) as 0 | 1;
    const second = (1 - first) as 0 | 1;
    const cols: [number, number] = [a, b];
    s = reveal(s, ctx(pkOf(first)), cols[first], salt(first, round));
    s = resolve(s, ctx(pkOf(second)), cols[second], salt(second, round));
  }
  return { s, vanished };
}

/** Optionally advance a completed-rounds state part-way into the next round. */
function intoRound(s: SimulState, stop: number, seed: number): SimulState {
  if (stop === 0 || isBoardFull(s.board)) return s;
  const open = legalSimulColumns(s);
  const a = open[seed % open.length]!;
  s = commit(s, ctx(P1), commitmentOf(a, salt(0, s.round)));
  if (stop === 1) return s;
  const b = open[(seed + 1) % open.length]!;
  s = commit(s, ctx(P2), commitmentOf(b, salt(1, s.round)));
  if (stop === 2) return s;
  return reveal(s, ctx(P1), a, salt(0, s.round));
}

const arbSeeds = fc.array(fc.tuple(fc.nat(6), fc.nat(6), fc.nat(1)), { maxLength: 42 });
const arbStop = fc.nat(3);
const arbWitness = fc.record({
  col: fc.integer({ min: -2, max: COLS + 1 }),
  row: fc.integer({ min: -2, max: ROWS + 1 }),
  dir: fc.integer({ min: -1, max: DIRS.length }),
});

describe("invariants over random legal simul games", () => {
  test("gravity holds and disc counts reconcile round-for-round, vanish included", () => {
    fc.assert(
      fc.property(arbSeeds, (seeds) => {
        const { s, vanished } = reachableSimul(seeds);
        let discs = 0;
        const perPlayer = [0, 0];
        for (let c = 0; c < COLS; c++) {
          const h = heightOf(s.board, c);
          for (let r = 0; r < ROWS; r++) {
            const cell = s.board[cellIndex(c, r)]!;
            expect([0, 1, 2]).toContain(cell);
            expect(cell !== 0).toBe(r < h);
            if (cell !== 0) {
              discs++;
              perPlayer[cell - 1]!++;
            }
          }
        }
        // Each round drops one disc per player, minus that player's vanishes.
        expect(perPlayer[0]).toBe(s.round - vanished[0]);
        expect(perPlayer[1]).toBe(s.round - vanished[1]);
        expect(discs).toBe(2 * s.round - vanished[0] - vanished[1]);
      }),
    );
  });

  test("every reachable state has exactly one derived phase and clean slots", () => {
    fc.assert(
      fc.property(arbSeeds, arbStop, fc.nat(6), (seeds, stop, seed) => {
        const s = intoRound(reachableSimul(seeds).s, stop, seed);
        // At most one reveal, and a revealer's commitment slot is always zeroed.
        expect(s.reveal1 === 0 || s.reveal2 === 0).toBe(true);
        if (s.reveal1 !== 0) expect(s.commit1).toBe(ZERO_HASH);
        if (s.reveal2 !== 0) expect(s.commit2).toBe(ZERO_HASH);
        const phase = roundPhase(s);
        expect(["commit", "reveal", "resolve"]).toContain(phase);
        if (phase === "resolve") expect(s.reveal1 !== 0 || s.reveal2 !== 0).toBe(true);
        if (phase === "reveal")
          expect(s.commit1 !== ZERO_HASH && s.commit2 !== ZERO_HASH).toBe(true);
      }),
    );
  });

  test("serialization round-trips every reachable state, mid-round included", () => {
    fc.assert(
      fc.property(arbSeeds, arbStop, fc.nat(6), (seeds, stop, seed) => {
        const s = intoRound(reachableSimul(seeds).s, stop, seed);
        expect(decodeSimulState(encodeSimulState(s))).toEqual(s);
      }),
    );
  });

  test("a stranger is rejected at every round door", () => {
    fc.assert(
      fc.property(arbSeeds, fc.nat(6), (seeds, seed) => {
        const { s } = reachableSimul(seeds);
        fc.pre(!isBoardFull(s.board));
        const open = legalSimulColumns(s);
        const col = open[seed % open.length]!;
        expect(() => commit(s, ctx(STRANGER), commitmentOf(col, salt(0, s.round)))).toThrow(
          "only a player may act",
        );
      }),
    );
  });
});

describe("witness scheme vs the naive oracle", () => {
  test("claimWin pays the line's owner iff the oracle confirms that exact line", () => {
    fc.assert(
      fc.property(arbSeeds, arbWitness, fc.nat(1), (seeds, w, player) => {
        const { s } = reachableSimul(seeds);
        const disc = discOf(player as 0 | 1);
        const oracleSaysWin = allWinningLines(s.board, disc).some(
          (l) => l.col === w.col && l.row === w.row && l.dir === w.dir,
        );
        const claim = () => claimWin(s, ctx(pkOf(player as 0 | 1)), w);
        if (oracleSaysWin) {
          expect(claim()).toEqual([{ to: pkOf(player as 0 | 1), amount: 2n * STAKE }]);
        } else {
          expect(claim).toThrow(/invalid win witness|not your line/);
        }
      }),
    );
  });

  test("with no real four-in-a-row, EVERY witness fails for both players", () => {
    fc.assert(
      fc.property(arbSeeds, (seeds) => {
        const { s } = reachableSimul(seeds);
        fc.pre(
          allWinningLines(s.board, 1).length === 0 && allWinningLines(s.board, 2).length === 0,
        );
        for (let wc = 0; wc < COLS; wc++)
          for (let wr = 0; wr < ROWS; wr++)
            for (let wd = 0; wd < DIRS.length; wd++) {
              const w = { col: wc, row: wr, dir: wd };
              expect(() => claimWin(s, ctx(P1), w)).toThrow(/invalid win witness|not your line/);
              expect(() => claimWin(s, ctx(P2), w)).toThrow(/invalid win witness|not your line/);
            }
      }),
      { numRuns: 25 },
    );
  });
});
