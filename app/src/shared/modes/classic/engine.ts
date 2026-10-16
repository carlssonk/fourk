/**
 * Classic mode, engine surface: alternating turns, one disc per move, the
 * FourkLobby/FourkMatch actor pair. The unnamed default of the pre-mode app,
 * now named.
 */

import { applyMove, legalColumns, playerToMove, type State } from "../../lib/game";
import { phaseOf, toHex, type Match } from "../../lib/match";
import type { ActorState, SpendInfo } from "../../lib/engine";
import type { ModeChainSurface, SpendClass } from "../types";
import { rederiveJoin } from "../common";

function isOpen(s: State): boolean {
  return phaseOf(s) === 0;
}

export const classicEngine = {
  /** An open seat is a FourkLobby; a joined match is a FourkMatch. */
  actorOf(m: Match): string {
    return isOpen(m.state) ? "FourkLobby" : "FourkMatch";
  },

  /** The snapshot as the actor's state fields (contracts/fourk.ag). */
  stateOf(m: Match): ActorState {
    const s = m.state;
    if (isOpen(s)) return { p1: s.p1, move_timeout: s.moveTimeout, deadline: s.deadline };
    return {
      p1: s.p1,
      p2: s.p2,
      board: toHex(s.board),
      move_count: s.moveCount,
      move_timeout: s.moveTimeout,
      deadline: s.deadline,
    };
  },

  /** Quick Match changes nothing on chain here: no flag waives the
   * joiner's wait, so a Classic Quick Match joiner leaves as an invite's
   * does, after one move clock. */
  genesisFields(_timing, _opts): Partial<Match> {
    return {};
  },

  joinerExitWait(m: Match): number {
    return m.state.moveTimeout;
  },

  /** No round machine, so nothing to mark: its joiner waits out one clock
   * to leave, as on an invite. */
  quickLobbyMarks(m: Match): boolean {
    return m.simul === undefined;
  },

  /** No covenant flag: only our own record knows. */
  isQuickMatched(m: Match): boolean {
    return !!m.paired;
  },

  /** Classic's draw has no age gate. */
  drawAge(_m: Match): number {
    return 0;
  },

  joinFields(_m: Match): Partial<Match> {
    return {};
  },

  /** Every live successor is a legal move of the player to move. */
  successors(m: Match): Match[] {
    if (isOpen(m.state)) return [];
    return legalColumns(m.state).map((c) => ({ ...m, state: applyMove(m.state, c) }));
  },

  /** Only the join (the unknown joiner pubkey) is blind. */
  canEnumerate(m: Match): boolean {
    return !isOpen(m.state);
  },

  rederiveSpend(m: Match, spend: SpendInfo): Match | null {
    return rederiveJoin(m, spend, {});
  },

  /** Only a TRACED terminal door reads as an ending. An untraceable spend
   * (pruned checkpoint, UTXO-index race, a node that can't serve the trace)
   * proves nothing: declaring it terminal would persist "The game has
   * ended." onto a live match — and in a staked game the player who stops
   * playing then loses the pot to claim_forfeit. Continuations (join, and
   * any move whose adoption failed) retry too. */
  classifySpend(spend: SpendInfo | null): SpendClass {
    return !spend || spend.kind === "join" || spend.kind === "move" ? "continuation" : "terminal";
  },

  progress(m: Match): number {
    return m.state.moveCount;
  },

  isActionable(m: Match, pkHex: string): boolean {
    const mover = playerToMove(m.state) === 0 ? m.state.p1 : m.state.p2;
    return mover === pkHex;
  },
} satisfies ModeChainSurface;
