/**
 * Liveness for the shared-deadline rules: from every reachable state, once
 * the clocks run out, a stranger holding no key can return the WHOLE pot to
 * the players. The V1 property (simul.properties.test.ts) restated with
 * acceptance scores threaded through every transition, so late first picks,
 * late second picks, graced cutoffs, first-round stalls, pending wins and
 * the cap all appear among the walked states.
 */

import { expect, test } from "vitest";
import fc from "fast-check";
import * as v2 from "../src/simul-v2/rules.js";
import { legalSimulColumns } from "../src/simul/rules.js";
import { isBoardFull } from "../src/simul/state.js";
import { commitmentOf } from "../src/simul/hash.js";
import { COLS, ROWS, cellIndex } from "../src/state.js";
import { DIRS, type LineWitness, type Payout } from "../src/rules.js";
import { P1, P2, STAKE, STRANGER, ctx } from "./helpers.js";

const T = 1200;
const R = 600;
const CAP = 60_000;
const key = (p: 0 | 1) => (p === 0 ? P1 : P2);
const saltOf = (p: number, round: number) => new Uint8Array(32).fill(0x10 * (p + 1) + (round % 16));
const at = (signer: string, inputDaa: number, txTime = 0, utxoAge = 0): v2.Ctx => ({
  ...ctx(signer),
  inputDaa,
  txTime,
  utxoAge,
});

function lineOf(board: Uint8Array, disc: number): LineWitness | null {
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
        if (ok) return { col, row, dir };
      }
  return null;
}

/** One step's choices: who picks first, both columns, who reveals first,
 * the acceptance gap of each transition (sometimes past the window), and
 * whether to stop part-way through the round. */
const arbStep = fc.record({
  first: fc.integer({ min: 0, max: 1 }),
  a: fc.nat(6),
  b: fc.nat(6),
  revealFirst: fc.integer({ min: 0, max: 1 }),
  gaps: fc.array(fc.integer({ min: 1, max: 2 * T }), { minLength: 4, maxLength: 4 }),
  stop: fc.integer({ min: 0, max: 6 }),
  claim: fc.boolean(),
});

/** Walk a game; returns the state reached and its UTXO's acceptance score. */
function walk(steps: Array<typeof arbStep extends fc.Arbitrary<infer X> ? X : never>) {
  let s = v2.join(v2.newMatch(P1, STAKE, T, CAP, R), at(P2, 0));
  let score = 100;
  for (const step of steps) {
    if (isBoardFull(s.board) || s.pendingWin) break;
    const cols = legalSimulColumns(s);
    const pick: [number, number] = [cols[step.a % cols.length]!, cols[step.b % cols.length]!];
    const first = step.first as 0 | 1;
    const second = (1 - first) as 0 | 1;
    const round = s.round;
    const advance = (next: () => v2.State, gap: number): boolean => {
      try {
        s = next();
        score += gap;
        return true;
      } catch {
        return false; // late: the state stays where the chain left it
      }
    };
    if (step.stop === 0) break;
    if (
      !advance(
        () =>
          v2.commit(
            s,
            at(key(first), score),
            commitmentOf(first, pick[first], saltOf(first, round)),
          ),
        step.gaps[0]!,
      )
    )
      break;
    if (step.stop === 1) break;
    if (
      !advance(
        () =>
          v2.commit(
            s,
            at(key(second), score),
            commitmentOf(second, pick[second], saltOf(second, round)),
          ),
        step.gaps[1]!,
      )
    )
      break;
    if (step.stop === 2) break;
    const rf = step.revealFirst as 0 | 1;
    const rs = (1 - rf) as 0 | 1;
    if (
      !advance(() => v2.reveal(s, at(key(rf), score), pick[rf], saltOf(rf, round)), step.gaps[2]!)
    )
      break;
    if (step.stop === 3) break;
    if (
      !advance(() => v2.resolve(s, at(key(rs), score), pick[rs], saltOf(rs, round)), step.gaps[3]!)
    )
      break;
    if (step.claim)
      for (const disc of [1, 2] as const) {
        const line = lineOf(s.board, disc);
        if (line && !s.pendingWin) s = v2.claimWin(s, at(disc === 1 ? P1 : P2, score), line);
      }
  }
  return { s, score };
}

const total = (outs: Payout[]) => outs.reduce((sum, o) => sum + o.amount, 0n);

test("every reachable V2 state has a permissionless exit paying the whole pot to the players", () => {
  fc.assert(
    fc.property(fc.array(arbStep, { minLength: 1, maxLength: 24 }), (steps) => {
      const { s, score } = walk(steps);
      // Every clock long past: any lock time, any age.
      const late = at(STRANGER, score, CAP + score + 10 * T, 10 * T);
      const exits = [
        () => v2.claimDraw(s, late),
        () => v2.splitTimeout(s, late),
        () => v2.suddenDeath(s, late),
      ];
      const payouts = exits.flatMap((exit) => {
        try {
          return [exit()];
        } catch {
          return [];
        }
      });
      expect(payouts.length).toBeGreaterThan(0);
      for (const outs of payouts) {
        expect(total(outs)).toBe(2n * STAKE);
        for (const o of outs) expect([s.p1, s.p2]).toContain(o.to);
      }
      // Doors that open together agree on who is paid what.
      const shapes = new Set(
        payouts.map((outs) =>
          JSON.stringify(outs, (_, v) => (typeof v === "bigint" ? String(v) : v)),
        ),
      );
      expect(shapes.size).toBe(1);
    }),
    { numRuns: 400 },
  );
});
