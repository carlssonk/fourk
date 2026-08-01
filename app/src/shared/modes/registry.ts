/**
 * The mode registry: every playable rule set, in picker order. This is the
 * only module that knows all modes; everything above it (covenant facade,
 * state, UI) asks `modeOf(match)` and works against the GameMode interface.
 */

import type { Match } from "../lib/match";
import type { GameMode, GameModeKey } from "./types";
import { classicMode } from "./classic";
import { fourkMode } from "./fourk";

export const MODES: Record<GameModeKey, GameMode> = {
  classic: classicMode,
  fourk: fourkMode,
};

/** Picker order: the signature mode first. */
export const MODE_LIST: GameMode[] = [fourkMode, classicMode];

/** The mode hosted games default to. */
export const DEFAULT_MODE_KEY: GameModeKey = "fourk";

/** A Match's mode. The wire rule "absent = classic" is interpreted here and
 * in the codecs — nowhere else. */
export function modeOf(m: Match): GameMode {
  return m.mode === "fourk" ? fourkMode : classicMode;
}

/** Parse a stored mode key (settings), falling back to the default. */
export function parseModeKey(raw: string | null): GameModeKey {
  return raw !== null && raw in MODES ? (raw as GameModeKey) : DEFAULT_MODE_KEY;
}

/** The more advanced of two snapshots of the same match, by the mode's own
 * progress key (classic: move count; fourk: round sub-phase — commits and
 * reveals move the game forward without landing a disc). */
export function fresherOf(a: Match, b: Match): Match {
  return modeOf(a).progress(a) >= modeOf(b).progress(b) ? a : b;
}

/** Fan the stored-list prune out to every mode's local-state GC. */
export function onMatchesPruned(keptCovenantIds: string[]): void {
  for (const mode of MODE_LIST) mode.onMatchesPruned?.(keptCovenantIds);
}
