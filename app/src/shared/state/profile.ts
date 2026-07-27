import { atom, getDefaultStore } from "jotai";
import { genesToCode, randomGenes } from "../lib/avatar";
import type { MatchTiming } from "../lib/covenant";
import { MIN_MOVE_TIMEOUT_DAA, MOVE_TIMEOUT_DAA } from "../lib/game";
import { trimName, type PlayerProfile } from "../lib/match";

const KEY = "fourk.profile";
const store = getDefaultStore();

function load(): PlayerProfile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (typeof raw.name === "string" && /^[0-9a-f]{16}$/.test(raw.avatar)) {
      return { name: trimName(raw.name), avatar: raw.avatar };
    }
  } catch {
    /* absent or corrupt — start fresh */
  }
  // A face from day one; the empty name is what forces the setup prompt.
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

/** The disc colour this player hosts games as (a match setting, not part of
 * the shareable identity — the joiner always gets the other colour). */
export const hostColorAtom = atom<"red" | "blue">(
  localStorage.getItem(COLOR_KEY) === "blue" ? "blue" : "red",
);

export function getHostColor(): "red" | "blue" {
  return store.get(hostColorAtom);
}

export function saveHostColor(c: "red" | "blue"): void {
  store.set(hostColorAtom, c);
  localStorage.setItem(COLOR_KEY, c);
}

// --- Match timing (host-side settings, remembered per player) ----------------

const TIMEOUT_KEY = "fourk.movetimeout";
const CAP_KEY = "fourk.gamecap";

function loadDaa(key: string, fallback: number, min = 0): number {
  const raw = localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** Per-move forfeit clock for hosted games, DAA blocks. */
export const moveTimeoutAtom = atom<number>(
  loadDaa(TIMEOUT_KEY, MOVE_TIMEOUT_DAA, MIN_MOVE_TIMEOUT_DAA),
);

/** Total game cap for hosted games, DAA blocks; 0 = uncapped. */
export const gameCapAtom = atom<number>(loadDaa(CAP_KEY, 0));

export function saveMoveTimeout(daa: number): void {
  if (!Number.isInteger(daa) || daa < MIN_MOVE_TIMEOUT_DAA) return;
  store.set(moveTimeoutAtom, daa);
  localStorage.setItem(TIMEOUT_KEY, String(daa));
}

export function saveGameCap(daa: number): void {
  if (!Number.isInteger(daa) || daa < 0) return;
  store.set(gameCapAtom, daa);
  localStorage.setItem(CAP_KEY, String(daa));
}

export function getMatchTiming(): MatchTiming {
  return { moveTimeout: store.get(moveTimeoutAtom), totalCap: store.get(gameCapAtom) };
}

// Cross-tab: adopt identity/settings saved from another tab (storage events
// only fire in other tabs, so re-loading here can't echo).
window.addEventListener("storage", (ev) => {
  if (ev.key === KEY) store.set(profileAtom, load());
  else if (ev.key === COLOR_KEY)
    store.set(hostColorAtom, localStorage.getItem(COLOR_KEY) === "blue" ? "blue" : "red");
  else if (ev.key === TIMEOUT_KEY)
    store.set(moveTimeoutAtom, loadDaa(TIMEOUT_KEY, MOVE_TIMEOUT_DAA, MIN_MOVE_TIMEOUT_DAA));
  else if (ev.key === CAP_KEY) store.set(gameCapAtom, loadDaa(CAP_KEY, 0));
});
