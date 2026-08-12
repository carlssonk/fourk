import { atom, getDefaultStore } from "jotai";
import { genesToCode, randomGenes } from "../lib/avatar";
import type { MatchTiming } from "../lib/covenant";
import { MAX_MOVE_TIMEOUT_DAA, MIN_MOVE_TIMEOUT_DAA, MOVE_TIMEOUT_DAA } from "../lib/game";
import { trimName, type PlayerProfile } from "../lib/match";
import { parseModeKey } from "../modes/registry";
import type { GameModeKey } from "../modes/types";

const KEY = "fourk.profile";
const store = getDefaultStore();

/** localStorage that reads null where storage is unavailable (node tests,
 * lockdown browsers) — every atom below starts at its default there. */
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function load(): PlayerProfile {
  try {
    const raw = JSON.parse(readItem(KEY) ?? "");
    if (typeof raw.name === "string" && /^[0-9a-f]{16}$/.test(raw.avatar)) {
      return { name: trimName(raw.name), avatar: raw.avatar };
    }
  } catch {
    /* absent or corrupt — start fresh */
  }
  // A face from day one; the name stays empty until first submit, where an
  // untouched field gets a generated one (PlayerSetup).
  return { name: "", avatar: genesToCode(randomGenes()) };
}

/** The local player's identity: picked in PlayerSetup, stamped onto matches. */
export const profileAtom = atom<PlayerProfile>(load());

export function getProfile(): PlayerProfile {
  return store.get(profileAtom);
}

export function saveProfile(p: PlayerProfile): void {
  const clean = { name: trimName(p.name.trim()), avatar: p.avatar };
  store.set(profileAtom, clean);
  localStorage.setItem(KEY, JSON.stringify(clean));
}

const COLOR_KEY = "fourk.p1color";

/** The colour this player's discs are, as a standing preference rather than
 * a per-match choice — it can't be a matchmaking bucket (two players can't
 * both be red), so it belongs with the avatar, not with the game settings.
 * The opponent always takes the other colour; when hosting, the host's
 * preference wins. Pure paint either way: on-chain discs are only 1
 * (creator) and 2 (joiner), and the host moves first regardless. */
function loadDiscColor(): "red" | "blue" {
  return readItem(COLOR_KEY) === "red" ? "red" : "blue";
}

export const discColorAtom = atom<"red" | "blue">(loadDiscColor());

export function getDiscColor(): "red" | "blue" {
  return store.get(discColorAtom);
}

export function saveDiscColor(c: "red" | "blue"): void {
  store.set(discColorAtom, c);
  localStorage.setItem(COLOR_KEY, c);
}

// --- Game mode (host-side setting) --------------------------------------------

const MODE_KEY = "fourk.gamemode";

export type GameMode = GameModeKey;

/** The mode hosted games open in — any registered mode; the registry's
 * default (the signature fourk mode) when unset or unrecognized. */
export const gameModeAtom = atom<GameModeKey>(parseModeKey(readItem(MODE_KEY)));

export function getGameMode(): GameModeKey {
  return store.get(gameModeAtom);
}

export function saveGameMode(mode: GameModeKey): void {
  store.set(gameModeAtom, mode);
  localStorage.setItem(MODE_KEY, mode);
}

// --- Stake (host-side setting) ------------------------------------------------

const STAKE_KEY = "fourk.stake";

function loadStake(): bigint {
  try {
    const v = BigInt(readItem(STAKE_KEY) ?? "0");
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

/** The stake hosted games open with, in sompi; 0 = free play, which opens
 * at the hidden drip-funded FREE_STAKE instead. Anything above 0 makes the
 * game staked: pot visible, seats funded from the players' own balances. */
export const stakeAtom = atom<bigint>(loadStake());

export function getStake(): bigint {
  return store.get(stakeAtom);
}

export function saveStake(sompi: bigint): void {
  if (sompi < 0n) return;
  store.set(stakeAtom, sompi);
  localStorage.setItem(STAKE_KEY, String(sompi));
}

// --- Match timing (host-side settings, remembered per player) ----------------

const TIMEOUT_KEY = "fourk.movetimeout";

function loadDaa(key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = readItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Per-move forfeit clock for hosted games, DAA blocks. */
export const moveTimeoutAtom = atom<number>(
  loadDaa(TIMEOUT_KEY, MOVE_TIMEOUT_DAA, MIN_MOVE_TIMEOUT_DAA, MAX_MOVE_TIMEOUT_DAA),
);

export function saveMoveTimeout(daa: number): void {
  if (!Number.isInteger(daa) || daa < MIN_MOVE_TIMEOUT_DAA || daa > MAX_MOVE_TIMEOUT_DAA) return;
  store.set(moveTimeoutAtom, daa);
  localStorage.setItem(TIMEOUT_KEY, String(daa));
}

/** The sudden-death cap, as a multiple of the per-move clock. An honest game
 * cannot brush it — 42 moves x one clock each is the theoretical ceiling and
 * this is triple that — so its only job is being the guaranteed
 * permissionless exit: if BOTH players vanish (lost keys, cleared storage),
 * anyone can eventually split the pot back to them instead of the funds
 * being stranded forever. The covenant refuses to seat a joiner without a
 * deadline, so hosting without one is no longer an option. */
const TOTAL_CAP_CLOCKS = 128;
/** Floor for the cap (~1 day): blitz clocks shouldn't make lobbies that
 * sudden-death out from under a player who answered an invite over lunch. */
const MIN_TOTAL_CAP_DAA = 864_000;

export function getMatchTiming(): MatchTiming {
  const moveTimeout = store.get(moveTimeoutAtom);
  return { moveTimeout, totalCap: Math.max(MIN_TOTAL_CAP_DAA, TOTAL_CAP_CLOCKS * moveTimeout) };
}

/** Cross-tab (called once from initStateLayer): adopt identity/settings
 * saved from another tab (storage events only fire in other tabs, so
 * re-loading here can't echo). */
export function wireProfileCrossTab(): void {
  window.addEventListener("storage", (ev) => {
    if (ev.key === KEY) store.set(profileAtom, load());
    else if (ev.key === COLOR_KEY) store.set(discColorAtom, loadDiscColor());
    else if (ev.key === TIMEOUT_KEY)
      store.set(
        moveTimeoutAtom,
        loadDaa(TIMEOUT_KEY, MOVE_TIMEOUT_DAA, MIN_MOVE_TIMEOUT_DAA, MAX_MOVE_TIMEOUT_DAA),
      );
    else if (ev.key === STAKE_KEY) store.set(stakeAtom, loadStake());
    else if (ev.key === MODE_KEY) store.set(gameModeAtom, parseModeKey(readItem(MODE_KEY)));
  });
}
