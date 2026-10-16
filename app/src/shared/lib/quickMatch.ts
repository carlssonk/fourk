/**
 * Quick Match terms (docs/adr/0003): the one game everyone in a mode's
 * queue is paired into. The matchmaker checks a hosted lobby against them,
 * and the joiner checks again before taking the seat, so nothing rests on
 * the matchmaker being honest.
 */

import { core2Of, isCore2 } from "../modes/fourk2/core";
import { modeOf } from "../modes/registry";
import type { GameModeKey } from "../modes/types";
import { isOpen } from "./game";
import { FREE_STAKE, NETWORK_ID, type Match } from "./match";

/** Per-move clock, DAA blocks: about 2 minutes on testnet-10, in both
 * modes. Twice the covenant's floor, leaving room for confirmation latency;
 * Fourk picks are blind and simultaneous, so some thinking time is fair. */
export const QUICK_MATCH_MOVE_TIMEOUT = 1_200;

/** The cap isn't compared here: it's an absolute DAA score set at open, so
 * the joiner holds it to the preset at join (state/quickMatch.ts, through
 * `assertJoinableDeadline`'s floor). */
export function isQuickMatchTerms(m: Match, mode: GameModeKey): boolean {
  if (
    m.network !== NETWORK_ID ||
    modeOf(m).meta.key !== mode ||
    m.state.stake !== FREE_STAKE ||
    m.state.moveTimeout !== QUICK_MATCH_MOVE_TIMEOUT ||
    !isOpen(m.state)
  )
    return false;
  // Classic has no Quick Match flag: its joiner waits out one clock to
  // leave, as on an invite.
  if (mode === "classic") return m.simul === undefined;
  return (
    isCore2(m.simul) &&
    core2Of(m).revealTimeout === QUICK_MATCH_MOVE_TIMEOUT &&
    core2Of(m).quick === 1
  );
}
