/**
 * Fourk-mode (simultaneous) bridge: re-export the reference implementation
 * from fourk/src/simul and adapt it to the app's Match model.
 *
 * A simul match keeps the classic `State` shape (board, keys, stake, timing —
 * `moveCount` is maintained as the disc count) and carries the round machine
 * in a separate `SimulCore`: round number, both commitment slots, both
 * reveal slots. `toSimulState` zips the two back into the reference's
 * `SimulState` whenever rules or scripts need it.
 */

import {
  ZERO_HASH,
  isBoardFull,
  priorityPlayer,
  roundPhase,
  type Commitment,
  type RoundPhase,
  type SimulState,
} from "../../../../../src/simul/state";
import {
  applyClaimWin,
  applyResolution,
  applyResolve,
  applyReveal,
  claimWin as simulClaimWin,
  commit as simulCommit,
  legalSimulColumns,
  resolve as simulResolve,
  reveal as simulReveal,
} from "../../../../../src/simul/rules";
import { SALT_BYTES, commitmentOf } from "../../../../../src/simul/hash";
import { type State, ZERO_PK } from "../../lib/game";

export {
  ZERO_HASH,
  SALT_BYTES,
  applyClaimWin,
  applyResolution,
  applyResolve,
  applyReveal,
  commitmentOf,
  isBoardFull,
  legalSimulColumns,
  priorityPlayer,
  roundPhase,
  simulClaimWin,
  simulCommit,
  simulResolve,
  simulReveal,
};
export type { Commitment, RoundPhase, SimulState };

/** The round machine's state, carried on a Match next to the classic State. */
export interface SimulCore {
  round: number;
  commit1: Commitment;
  commit2: Commitment;
  reveal1: number;
  reveal2: number;
  /** 0 = normal play; 1/2 = that color proved a line and the challenge
   * window is open (see SimulState.pendingWin in the reference). */
  pendingWin: number;
}

export const ZERO_CORE: SimulCore = {
  round: 0,
  commit1: ZERO_HASH,
  commit2: ZERO_HASH,
  reveal1: 0,
  reveal2: 0,
  pendingWin: 0,
};

/** The round machine of a match, defaulted for records from before the slot
 * existed (a fresh fourk match's core is all-zeros anyway). The ONE place
 * "absent core" is interpreted — never write `?? ZERO_CORE` elsewhere. */
export function coreOf(m: { simul?: SimulCore }): SimulCore {
  return m.simul ?? ZERO_CORE;
}

export function toSimulState(s: State, core: SimulCore = ZERO_CORE): SimulState {
  return {
    board: s.board,
    round: core.round,
    p1: s.p1,
    p2: s.p2,
    commit1: core.commit1,
    commit2: core.commit2,
    reveal1: core.reveal1,
    reveal2: core.reveal2,
    pendingWin: core.pendingWin ?? 0,
    stake: s.stake,
    moveTimeout: s.moveTimeout,
    deadline: s.deadline,
  };
}

/** Split a reference SimulState back into the app's (State, SimulCore) pair.
 * moveCount is kept as the disc count — the classic derivations (share-code
 * compaction, glance labels) all reduce to it. */
export function fromSimulState(ss: SimulState): { state: State; simul: SimulCore } {
  let discs = 0;
  for (const c of ss.board) if (c !== 0) discs++;
  return {
    state: {
      board: ss.board,
      moveCount: discs,
      p1: ss.p1,
      p2: ss.p2,
      stake: ss.stake,
      moveTimeout: ss.moveTimeout,
      deadline: ss.deadline,
    },
    simul: {
      round: ss.round,
      commit1: ss.commit1,
      commit2: ss.commit2,
      reveal1: ss.reveal1,
      reveal2: ss.reveal2,
      pendingWin: ss.pendingWin,
    },
  };
}

/** Monotone progress key for fresherOf: rounds tick by 5, sub-phases by 1
 * (one commit, both commits, one reveal), and a pending win outranks every
 * sub-phase of its round (claimWin keeps the round number but must still
 * read as fresher than the state it spent). */
export function simulProgress(core: SimulCore): number {
  const commits = (core.commit1 !== ZERO_HASH ? 1 : 0) + (core.commit2 !== ZERO_HASH ? 1 : 0);
  const sub = core.pendingWin !== 0 ? 4 : core.reveal1 !== 0 || core.reveal2 !== 0 ? 3 : commits;
  return core.round * 5 + sub;
}

export type Obligation = "commit" | "reveal" | "resolve";

/** What `pkHex` owes the current round, if anything. This is the simul
 * analog of "is it my turn": null means we're waiting on the opponent (or
 * not a player, or the board is full). */
export function myObligation(s: State, core: SimulCore, pkHex: string): Obligation | null {
  // A pending win suspends the round machine — the contest and the sweep
  // are autopilot duties, not obligations with a forfeit clock on them.
  if (core.pendingWin !== 0) return null;
  if (s.p2 === ZERO_PK || isBoardFull(s.board)) return null;
  const player = s.p1 === pkHex ? 0 : s.p2 === pkHex ? 1 : null;
  if (player === null) return null;
  const phase = roundPhase(toSimulState(s, core));
  if (phase === "commit") {
    const mine = player === 0 ? core.commit1 : core.commit2;
    return mine === ZERO_HASH ? "commit" : null;
  }
  if (phase === "reveal") return "reveal";
  // One reveal on the table: the other player owes the resolve.
  const myReveal = player === 0 ? core.reveal1 : core.reveal2;
  return myReveal === 0 ? "resolve" : null;
}
