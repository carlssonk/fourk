import { expect, test } from "vitest";
import * as v2 from "../src/simul-v2/rules.js";
import { P1, P2, STAKE, STRANGER, ctx } from "./helpers.js";
import { commitmentOf } from "../src/simul/hash.js";
import fc from "fast-check";

const at = (signer = P1, inputDaa = 1000, txTime = 0, utxoAge = 0) => ({
  ...ctx(signer),
  inputDaa,
  txTime,
  utxoAge,
});
const salt = (player: number) => new Uint8Array(32).fill(player + 1);
const pick = (player: 0 | 1, column = player) => commitmentOf(player, column, salt(player));
const draw = [
  { to: P1, amount: STAKE },
  { to: P2, amount: STAKE },
];
function joined() {
  return v2.join(v2.newMatch(P1, STAKE, 1200, 100_000, 600), at(P2));
}
/** The first round played through: p1 picks column 0 at score 400, p2
 * column 1 at 500 (cutoff 1700), both reveal; the resolve output is the
 * second round's start. */
function started() {
  const one = v2.commit(joined(), at(P1, 400), pick(0));
  const two = v2.commit(one, at(P2, 500), pick(1));
  const shown = v2.reveal(two, at(P1, 600), 0, salt(0));
  return v2.resolve(shown, at(P2, 700), 1, salt(1));
}

test("the first pick starts the opponent's window; a stalled first round refunds instead of forfeiting", () => {
  for (const first of [0, 1] as const) {
    const second = (1 - first) as 0 | 1;
    const key = (p: number) => (p === 0 ? P1 : P2);
    const s = joined();
    // Either player may pick straight from the lobby; the lone commit stores
    // no cutoff — there is no round-start output to measure from yet.
    const one = v2.commit(s, at(key(first), 1000), pick(first));
    expect(one.pickDeadline).toBe(0);
    expect(one.firstCommitter).toBe(first + 1);
    expect(() => v2.commit(s, at(key(first), 100_000), pick(first))).toThrow(/limit/);
    // The lobby exits close at the first pick.
    expect(() => v2.dissolve(one, at(P1))).toThrow();
    expect(() => v2.dissolve(one, at(P2, 1000, 0, 9999))).toThrow();
    // The second pick's window runs from the first commit's own acceptance.
    const two = v2.commit(one, at(key(second), 1500), pick(second));
    expect(two.pickDeadline).toBe(2700);
    v2.reveal(two, at(key(first), 2700), first, salt(first));
    expect(() => v2.reveal(two, at(key(first), 2701), first, salt(first))).toThrow(/late/);
    // Nobody can be forfeited for a missing or late first-round pick: the
    // first committer's claim is refused, and the split waits out the window.
    expect(() => v2.claimTimeout(one, at(key(first), 1500, 9999, 9999))).toThrow(/first round/);
    expect(() => v2.splitTimeout(one, at(STRANGER, 1500, 2699))).toThrow(/not reached/);
    expect(v2.splitTimeout(one, at(STRANGER, 1500, 2700))).toEqual(draw);
    expect(() => v2.claimTimeout(two, at(key(first), 2701, 9999, 9999))).toThrow(/first round/);
    expect(v2.splitTimeout(two, at(STRANGER, 2701))).toEqual(draw);
    expect(() => v2.splitTimeout(two, at(STRANGER, 2700, 9999, 599))).toThrow(/reveal/);
    expect(v2.splitTimeout(two, at(STRANGER, 2700, 9999, 600))).toEqual(draw);
    // The cap keeps the same waits and only ever splits a first-round pick.
    expect(() => v2.suddenDeath(one, at(STRANGER, 99_950, 100_000, 9999))).toThrow(/not reached/);
    expect(v2.suddenDeath(one, at(STRANGER, 99_950, 101_150))).toEqual(draw);
    expect(v2.suddenDeath(two, at(STRANGER, 2701, 100_000))).toEqual(draw);
    expect(() => v2.suddenDeath(two, at(STRANGER, 2700, 100_000, 599))).toThrow(/reveal/);
    expect(v2.suddenDeath(two, at(STRANGER, 2700, 100_000, 600))).toEqual(draw);
    // A reveal on the table is a proven obligation even in the first round.
    const shown = v2.reveal(two, at(key(first), 2700), first, salt(first));
    const win = [{ to: key(first), amount: 2n * STAKE }];
    expect(() => v2.claimTimeout(shown, at(key(first), 2800, 0, 599))).toThrow();
    expect(v2.claimTimeout(shown, at(key(first), 2800, 0, 600))).toEqual(win);
    expect(v2.suddenDeath(shown, at(STRANGER, 2800, 100_000, 600))).toEqual(win);
  }
  // The lobby itself keeps its exits.
  expect(v2.dissolve(joined(), at(P1))).toEqual(draw);
  expect(() => v2.dissolve(joined(), at(P2, 1000, 0, 1199))).toThrow();
  expect(v2.dissolve(joined(), at(P2, 1000, 0, 1200))).toEqual(draw);
  expect(() => v2.splitTimeout(joined(), at(STRANGER, 1000, 9999, 1199))).toThrow(/lobby/);
  expect(v2.splitTimeout(joined(), at(STRANGER, 1000, 9999, 1200))).toEqual(draw);
  // And the second round anchors on the resolve output as every later one.
  expect(started().round).toBe(1);
  expect(started().pickDeadline).toBe(0);
});

test("either commit order preserves the round-start deadline through reveal and resets only on resolution", () => {
  for (const first of [0, 1] as const) {
    const second = (1 - first) as 0 | 1;
    const key = (p: number) => (p === 0 ? P1 : P2);
    const one = v2.commit(started(), at(key(first), 1000), pick(first));
    expect(one.pickDeadline).toBe(2200);
    expect(one.firstCommitter).toBe(first + 1);
    // An early first commit leaves the shared deadline as the second cutoff.
    const two = v2.commit(one, at(key(second), 2100), pick(second));
    expect(two.pickDeadline).toBe(2200);
    const revealed = v2.reveal(two, at(key(first), 2200, 9000), first, salt(first));
    const next = v2.resolve(revealed, at(key(second), 9500), second, salt(second));
    expect(next.round).toBe(2);
    expect(next.pickDeadline).toBe(0);
    expect(next.firstCommitter).toBe(0);
    const nextPick = v2.commit(next, at(key(first), 10_000), pick(first));
    expect(nextPick.pickDeadline).toBe(11_200);
    expect(() => v2.commit(one, at(key(second), 2201), pick(second))).toThrow(/late/);
    expect(() => v2.reveal(two, at(key(first), 2201), first, salt(first))).toThrow(/late/);
    // A first commit accepted late in the window extends the second cutoff by
    // the rebase grace, and only that far.
    const graced = v2.commit(one, at(key(second), 2199), pick(second));
    expect(graced.pickDeadline).toBe(2299);
    v2.reveal(graced, at(key(second), 2299), second, salt(second));
    expect(() => v2.reveal(graced, at(key(second), 2300), second, salt(second))).toThrow(/late/);
    for (const inputDaa of [-1, Number.MAX_SAFE_INTEGER]) {
      expect(() => v2.commit(started(), at(key(first), inputDaa), pick(first))).toThrow();
      expect(() => v2.reveal(two, at(key(first), inputDaa), first, salt(first))).toThrow();
    }
  }
});

test("late submissions preserve the timeout outcome instead of resetting or escaping it", () => {
  expect(() => v2.splitTimeout(started(), at(STRANGER, 1000, 2199))).toThrow();
  expect(v2.splitTimeout(started(), at(STRANGER, 1000, 2200))).toEqual(draw);
  for (const first of [0, 1] as const) {
    const second = (1 - first) as 0 | 1;
    const key = (p: number) => (p === 0 ? P1 : P2);
    const win = [{ to: key(first), amount: 2n * STAKE }];
    const one = v2.commit(started(), at(key(first)), pick(first));
    expect(() => v2.claimTimeout(one, at(key(first), 2100, 2199))).toThrow();
    expect(v2.claimTimeout(one, at(key(first), 2100, 2200))).toEqual(win);
    expect(() => v2.claimTimeout(one, at(key(second), 2100, 2200))).toThrow();
    expect(() => v2.splitTimeout(one, at(STRANGER, 2100, 2200))).toThrow();
    expect(() => v2.claimTimeout(one, at(key(first), 2201, 2200))).toThrow();
    expect(v2.splitTimeout(one, at(STRANGER, 2201))).toEqual(draw);
    // The timeout claim waits out the second committer's rebase grace.
    expect(() => v2.claimTimeout(one, at(key(first), 2150, 2249))).toThrow();
    expect(v2.claimTimeout(one, at(key(first), 2150, 2250))).toEqual(win);
    const graced = v2.commit(one, at(key(second), 2199), pick(second));
    expect(() => v2.claimTimeout(graced, at(key(first), 2299))).toThrow();
    expect(v2.claimTimeout(graced, at(key(first), 2300))).toEqual(win);
    expect(v2.splitTimeout(graced, at(STRANGER, 2299, 9999, 600))).toEqual(draw);
    const two = v2.commit(one, at(key(second), 2100), pick(second));
    expect(v2.claimTimeout(two, at(key(first), 2201))).toEqual(win);
    expect(() => v2.claimTimeout(two, at(key(second), 2201))).toThrow();
    expect(() => v2.splitTimeout(two, at(STRANGER, 2201, 9999, 9999))).toThrow();
    expect(() => v2.claimTimeout(two, at(key(first), 2200, 9999))).toThrow();
    expect(() => v2.splitTimeout(two, at(STRANGER, 2200, 9999, 599))).toThrow();
    expect(v2.splitTimeout(two, at(STRANGER, 2200, 9999, 600))).toEqual(draw);
  }
});

test("the cap and reveal grace cannot turn a timeout winner into a refund", () => {
  const one = v2.commit(started(), at(P1), pick(0));
  const two = v2.commit(one, at(P2, 2100), pick(1));
  const win = [{ to: P1, amount: 2n * STAKE }];
  expect(v2.suddenDeath(one, at(STRANGER, 2100, 100_000))).toEqual(win);
  expect(v2.suddenDeath(two, at(STRANGER, 2201, 100_000))).toEqual(win);
  const revealed = v2.reveal(two, at(P1, 2200), 0, salt(0));
  expect(() => v2.claimTimeout(revealed, at(P1, 2300, 0, 599))).toThrow();
  expect(v2.claimTimeout(revealed, at(P1, 2300, 0, 600))).toEqual(win);
  expect(v2.suddenDeath(revealed, at(STRANGER, 2300, 100_000, 600))).toEqual(win);
  expect(() => v2.suddenDeath(revealed, at(STRANGER, 2300, 100_000, 599))).toThrow();
  expect(() => v2.commit(started(), at(P1, 100_000), pick(0))).toThrow(/limit/);
  // The cap cannot halve a declared winner; the separate reveal/contest
  // allowance, not the longer picking duration, protects the challenge.
  const board = new Uint8Array(42);
  board.set([1, 1, 1, 1]);
  const won = v2.claimWin({ ...started(), board }, at(P1), { col: 0, row: 0, dir: 1 });
  expect(() => v2.sweepWin(won, at(P1, 5000, 0, 599))).toThrow();
  expect(v2.sweepWin(won, at(P1, 5000, 0, 600))).toEqual(win);
  expect(v2.sweepWin(won, at(STRANGER, 5000, 0, 600))).toEqual(win);
  expect(v2.suddenDeath(won, at(STRANGER, 5000, 100_000, 600))).toEqual(win);
  // With nobody picked, the cap waits out the full picking window (or the
  // lobby clock) instead of the shorter reveal grace.
  expect(() => v2.suddenDeath(started(), at(STRANGER, 99_950, 100_000, 9999))).toThrow();
  expect(v2.suddenDeath(started(), at(STRANGER, 99_950, 101_150, 0))).toEqual(draw);
  expect(() => v2.suddenDeath(joined(), at(STRANGER, 99_950, 100_000, 1199))).toThrow();
  expect(v2.suddenDeath(joined(), at(STRANGER, 99_950, 100_000, 1200))).toEqual(draw);
});

test("a forged lobby cannot carry a cutoff or advertise an invalid reveal allowance", () => {
  const lobby = v2.newMatch(P1, STAKE, 1200, 100_000, 600);
  for (const revealTimeout of [0, 599, 1201, NaN]) {
    expect(() => v2.join({ ...lobby, revealTimeout }, at(P2))).toThrow();
  }
  expect(() => v2.join({ ...lobby, pickDeadline: 5 }, at(P2))).toThrow(/lobby/);
  expect(() => v2.join({ ...lobby, firstCommitter: 1 }, at(P2))).toThrow(/lobby/);
});

test("submission order and timing cannot change the cutoff or reward a late second pick", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<0 | 1>(0, 1),
      fc.integer({ min: 1, max: 80_000 }),
      fc.integer({ min: 0, max: 1200 }),
      fc.integer({ min: 1, max: 5000 }),
      (first, start, firstDelay, lateness) => {
        const second = (1 - first) as 0 | 1;
        const key = (p: number) => (p === 0 ? P1 : P2);
        const one = v2.commit(started(), at(key(first), start), pick(first));
        const two = v2.commit(one, at(key(second), start + firstDelay), pick(second));
        expect(two.pickDeadline).toBe(
          Math.max(one.pickDeadline, start + firstDelay + v2.REBASE_GRACE_DAA),
        );
        const actualAcceptance = two.pickDeadline + lateness;
        expect(v2.claimTimeout(two, at(key(first), actualAcceptance))).toEqual([
          { to: key(first), amount: 2n * STAKE },
        ]);
        expect(() =>
          v2.reveal(two, at(key(second), actualAcceptance), second, salt(second)),
        ).toThrow();
        expect(() =>
          v2.splitTimeout(two, at(STRANGER, actualAcceptance, 999_999, 999_999)),
        ).toThrow();
      },
    ),
    { numRuns: 300, seed: 19092026 },
  );
});

test("in the first round a late second pick can only ever be refunded", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<0 | 1>(0, 1),
      fc.integer({ min: 1, max: 80_000 }),
      fc.integer({ min: 0, max: 5000 }),
      fc.integer({ min: 1, max: 5000 }),
      (first, joinScore, firstDelay, lateness) => {
        const second = (1 - first) as 0 | 1;
        const key = (p: number) => (p === 0 ? P1 : P2);
        const one = v2.commit(joined(), at(key(first), joinScore), pick(first));
        expect(one.pickDeadline).toBe(0);
        const s1 = joinScore + firstDelay;
        const two = v2.commit(one, at(key(second), s1), pick(second));
        expect(two.pickDeadline).toBe(s1 + 1200);
        v2.reveal(two, at(key(second), s1 + 1200), second, salt(second));
        const actualAcceptance = two.pickDeadline + lateness;
        expect(() =>
          v2.reveal(two, at(key(second), actualAcceptance), second, salt(second)),
        ).toThrow(/late/);
        for (const claimant of [first, second])
          expect(() => v2.claimTimeout(two, at(key(claimant), actualAcceptance))).toThrow();
        expect(v2.splitTimeout(two, at(STRANGER, actualAcceptance))).toEqual(draw);
        expect(v2.suddenDeath(two, at(STRANGER, actualAcceptance, 100_000))).toEqual(draw);
        // The lone first pick, unanswered: a refund after its window, never a win.
        expect(() => v2.claimTimeout(one, at(key(first), s1, 999_999, 999_999))).toThrow();
        expect(() => v2.splitTimeout(one, at(STRANGER, s1, s1 + 1199))).toThrow();
        expect(v2.splitTimeout(one, at(STRANGER, s1, s1 + 1200))).toEqual(draw);
      },
    ),
    { numRuns: 300, seed: 20092026 },
  );
});

test("shape builders mirror the doors and the validator holds the V2 invariants", () => {
  const s = started();
  const one = v2.commit(s, at(P1, 1000), pick(0));
  expect(v2.applyCommit(s, 0, pick(0), 1000)).toEqual(one);
  const two = v2.commit(one, at(P2, 2199), pick(1));
  expect(v2.applyCommit(one, 1, pick(1), 2199)).toEqual(two);
  const revealed = v2.reveal(two, at(P1, 2200), 0, salt(0));
  expect(v2.applyReveal(two, 0, 0)).toEqual(revealed);
  expect(v2.applyResolve(revealed, 1, 1)).toEqual(v2.resolve(revealed, at(P2), 1, salt(1)));
  // The first round's shapes: no cutoff under the lone pick, S1 + T after.
  const firstOne = v2.commit(joined(), at(P2, 1000), pick(1));
  expect(v2.applyCommit(joined(), 1, pick(1), 1000)).toEqual(firstOne);
  const firstTwo = v2.commit(firstOne, at(P1, 1500), pick(0));
  expect(v2.applyCommit(firstOne, 0, pick(0), 1500)).toEqual(firstTwo);
  expect(firstTwo.pickDeadline).toBe(2700);
  const board = new Uint8Array(42);
  board.set([1, 1, 1, 1]);
  const lined = { ...one, board };
  expect(v2.applyClaimWin(lined, 1)).toEqual(
    v2.claimWin(lined, at(P1), { col: 0, row: 0, dir: 1 }),
  );
  for (const good of [
    joined(),
    firstOne,
    firstTwo,
    s,
    one,
    two,
    revealed,
    v2.applyClaimWin(lined, 1),
  ])
    expect(() => v2.validateReachableSimulV2State(good)).not.toThrow();
  const bad: Array<[Partial<v2.State>, RegExp]> = [
    [{ ...one, pickDeadline: 0 }, /below the picking window/],
    [{ ...firstOne, pickDeadline: 2200 }, /first-round lone commit/],
    [{ ...firstTwo, pickDeadline: 1199 }, /below the picking window/],
    [{ ...one, firstCommitter: 2 }, /mismatch/],
    [{ ...s, pickDeadline: 2200 }, /cutoff without a commit/],
    [{ ...revealed, pickDeadline: 2200, firstCommitter: 1 }, /cutoff without a commit/],
    [{ ...s, revealTimeout: 1201 }, /reveal timeout/],
  ];
  for (const [state, why] of bad)
    expect(() => v2.validateReachableSimulV2State(state as v2.State)).toThrow(why);
});
