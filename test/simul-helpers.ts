import { SimulState, newSimulMatch } from "../src/simul/state.js";
import { MOVE_TIMEOUT_DAA } from "../src/state.js";
import { commit, join, resolve, reveal } from "../src/simul/rules.js";
import { commitmentOf } from "../src/simul/hash.js";
import { DEADLINE, P1, P2, STAKE, ctx } from "./helpers.js";

/** Deterministic per-player, per-round salt — tests never need real entropy. */
export function salt(player: 0 | 1, round: number): Uint8Array {
  return new Uint8Array(32).fill(0x10 * (player + 1) + (round % 16));
}

export function pkOf(player: 0 | 1): string {
  return player === 0 ? P1 : P2;
}

/** A joined simul match, round 0, commit phase. */
export function simulGame(): SimulState {
  return join(newSimulMatch(P1, STAKE, MOVE_TIMEOUT_DAA, DEADLINE), ctx(P2));
}

/** Both players commit their sealed picks (p1 first — order is free). */
export function commitBoth(s: SimulState, colP1: number, colP2: number): SimulState {
  s = commit(s, ctx(P1), commitmentOf(0, colP1, salt(0, s.round)));
  return commit(s, ctx(P2), commitmentOf(1, colP2, salt(1, s.round)));
}

/**
 * Play one full round: both commit, `revealFirst` reveals, the other
 * resolves. Columns must be legal in the pre-round board.
 */
export function playRound(
  s: SimulState,
  colP1: number,
  colP2: number,
  revealFirst: 0 | 1 = 0,
): SimulState {
  const round = s.round;
  s = commitBoth(s, colP1, colP2);
  const cols: [number, number] = [colP1, colP2];
  const second = (1 - revealFirst) as 0 | 1;
  s = reveal(s, ctx(pkOf(revealFirst)), cols[revealFirst], salt(revealFirst, round));
  return resolve(s, ctx(pkOf(second)), cols[second], salt(second, round));
}

/** Play a sequence of rounds from [colP1, colP2] pairs. */
export function playRounds(s: SimulState, pairs: Array<[number, number]>): SimulState {
  for (const [a, b] of pairs) s = playRound(s, a, b);
  return s;
}
