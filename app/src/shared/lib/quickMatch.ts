/**
 * Quick Match terms (docs/adr/0003): the one game everyone in the queue is
 * paired into. The matchmaker checks a hosted lobby against them, and the
 * joiner checks again before taking the seat, so nothing rests on the
 * matchmaker being honest.
 */

import { core2Of, isCore2 } from "../modes/fourk2/core";
import { isOpen } from "./game";
import { FREE_STAKE, NETWORK_ID, type Match } from "./match";

/** Per-pick clock, DAA blocks: about 5 minutes on testnet-10. */
export const QUICK_MATCH_MOVE_TIMEOUT = 3_000;

/** The cap isn't compared here: it's an absolute DAA score set at open, so
 * the joiner holds it to the preset at join (state/quickMatch.ts, through
 * `assertJoinableDeadline`'s floor). */
export function isQuickMatchTerms(m: Match): boolean {
  return (
    m.network === NETWORK_ID &&
    m.mode === "fourk2" &&
    isCore2(m.simul) &&
    m.state.stake === FREE_STAKE &&
    m.state.moveTimeout === QUICK_MATCH_MOVE_TIMEOUT &&
    core2Of(m).revealTimeout === QUICK_MATCH_MOVE_TIMEOUT &&
    core2Of(m).quick === 1 &&
    isOpen(m.state)
  );
}
