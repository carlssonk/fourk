/**
 * Fourk V2 (shared picking deadlines) bridge: the reference rules from
 * fourk/src/simul-v2 adapted to the app's Match model. Everything the legacy
 * fourk core does still applies — a V2 match keeps the classic `State` plus a
 * round machine — and the round machine grows three fields: the shared
 * picking cutoff, who committed first, and the reveal grace.
 */

import * as v2 from "../../../../../src/simul-v2/rules";
import type { State } from "../../lib/game";
import { ZERO_CORE, toSimulState, type SimulCore } from "../fourk/core";

export { v2 };

export interface SimulCore2 extends SimulCore {
  /** The shared picking cutoff (DAA score) while a commit is on the table;
   * 0 under a lone first-round pick, whose opponent's window runs from that
   * pick's own acceptance instead (see the reference rules). */
  pickDeadline: number;
  /** 1/2 = which player committed first this round; 0 between rounds. */
  firstCommitter: number;
  /** Reveal inactivity and challenge-window grace, DAA (600 <= R <= T). */
  revealTimeout: number;
}

export function zeroCore2(revealTimeout: number): SimulCore2 {
  return { ...ZERO_CORE, pickDeadline: 0, firstCommitter: 0, revealTimeout };
}

export function isCore2(c: SimulCore | undefined): c is SimulCore2 {
  return (
    !!c &&
    typeof (c as SimulCore2).pickDeadline === "number" &&
    typeof (c as SimulCore2).firstCommitter === "number" &&
    typeof (c as SimulCore2).revealTimeout === "number"
  );
}

/** The V2 round machine of a match; throws on a record that lost it (a V2
 * address derives from these fields, so there is no safe default). */
export function core2Of(m: { simul?: SimulCore | undefined }): SimulCore2 {
  if (!isCore2(m.simul)) throw new Error("fourk2 match without its V2 round state");
  return m.simul;
}

export function toV2State(s: State, core: SimulCore2): v2.State {
  return {
    ...toSimulState(s, core),
    pickDeadline: core.pickDeadline,
    firstCommitter: core.firstCommitter,
    revealTimeout: core.revealTimeout,
  };
}

/** Split a reference V2 state back into the app's (State, SimulCore2) pair;
 * moveCount stays the disc count, as in the legacy bridge. */
export function fromV2State(ss: v2.State): { state: State; simul: SimulCore2 } {
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
      pickDeadline: ss.pickDeadline,
      firstCommitter: ss.firstCommitter,
      revealTimeout: ss.revealTimeout,
    },
  };
}

/** Hold an untrusted (State, core) pair to the V2 reachability invariants. */
export function validateCore2(s: State, core: SimulCore2): void {
  v2.validateReachableSimulV2State(toV2State(s, core));
}

export function commitCount(core: SimulCore): number {
  return Number(core.commit1 !== "00".repeat(32)) + Number(core.commit2 !== "00".repeat(32));
}
