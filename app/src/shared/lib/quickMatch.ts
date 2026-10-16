/**
 * Quick Match terms (docs/adr/0003): the one game everyone in a mode's
 * queue is paired into. The matchmaker checks a hosted lobby against them,
 * and the joiner checks again before taking the seat, so nothing rests on
 * the matchmaker being honest.
 */

import { modeOf } from "../modes/registry";
import type { GameModeKey } from "../modes/types";
import { isOpen } from "./game";
import { FREE_STAKE, NETWORK_ID, type Match } from "./match";

/** Per-move clock, DAA blocks: about 2 minutes on testnet-10, in both
 * modes. Twice the covenant's floor, leaving room for confirmation latency;
 * Fourk picks are blind and simultaneous, so some thinking time is fair. */
export const QUICK_MATCH_MOVE_TIMEOUT = 1_200;

/** The whole-game cap a Quick Match opens with, DAA: about a day, the floor
 * hosted games get (state/profile.ts timingFor) at this clock. */
export const QUICK_MATCH_TOTAL_CAP = 864_000;

/** The time limit a Quick Match lobby may have left, DAA: the cap, give or
 * take an hour either way. That covers the time between the host's open
 * and the join generously, since a pairing that slow has long been dropped
 * by the matchmaker. Checked by the matchmaker and again by the joiner. */
export const QUICK_MATCH_CAP_BOUNDS = {
  min: QUICK_MATCH_TOTAL_CAP - 36_000,
  max: QUICK_MATCH_TOTAL_CAP + 36_000,
};

/** The cap isn't compared here: it's an absolute DAA score set at open, so
 * it needs the chain's current score (QUICK_MATCH_CAP_BOUNDS, checked by the
 * matchmaker and at join through `assertJoinableDeadline`). */
export function isQuickMatchTerms(m: Match, mode: GameModeKey): boolean {
  if (
    m.network !== NETWORK_ID ||
    modeOf(m).meta.key !== mode ||
    m.state.stake !== FREE_STAKE ||
    m.state.moveTimeout !== QUICK_MATCH_MOVE_TIMEOUT ||
    !isOpen(m.state)
  )
    return false;
  return modeOf(m).quickLobbyMarks(m);
}
