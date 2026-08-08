import { atom, getDefaultStore } from "jotai";
import { knownMatchFromUrl, pendingInviteFromUrl, writeUrlHash } from "../lib/invite";
import { LIST_KEY, loadMatches, saveMatches, type Match } from "../lib/match";
import { fresherOf, onMatchesPruned } from "../modes/registry";

const store = getDefaultStore();

/** Persist the list and let every mode GC its per-match local state
 * (fourk prunes commitment salts) against the surviving ids. */
function persistMatches(list: Match[]): void {
  saveMatches(list);
  onMatchesPruned(list.map((m) => m.covenantId));
}

function upsert(list: Match[], m: Match): Match[] {
  return [m, ...list.filter((x) => x.covenantId !== m.covenantId)];
}

// The home screen is the hub: a bare root URL always lands there. A #g= link
// to a game we already track reopens that game directly (this is what makes a
// mid-game refresh seamless); a link to an unknown game becomes a pending
// invite. All read once at startup, outside React.
const initialCurrent = knownMatchFromUrl();
// If the URL delivered a fresher state than we had stored, persist it.
const initialMatches = initialCurrent ? upsert(loadMatches(), initialCurrent) : loadMatches();
if (initialCurrent) persistMatches(initialMatches);

const matchesBase = atom(initialMatches);

/** All stored matches, most recently touched first. Writes persist. */
export const matchesAtom = atom(
  (get) => get(matchesBase),
  (_get, set, list: Match[]) => {
    set(matchesBase, list);
    persistMatches(list);
  },
);

/** The match on screen, or null on the hub. */
export const currentMatchAtom = atom<Match | null>(initialCurrent);

/** An invite from the URL for a game we don't track yet. */
export const pendingInviteAtom = atom<Match | null>(pendingInviteFromUrl());

/** Upsert into the stored list; the on-screen game follows if it's the same
 * one. Profiles, colour and a recorded result are merged, never dropped: a
 * fresher snapshot that arrived without them (an on-chain discovery, a bare
 * link) keeps what we already know. */
export function updateMatch(m: Match): Match {
  const prev = store.get(matchesAtom).find((x) => x.covenantId === m.covenantId);
  const profiles = { ...prev?.profiles, ...m.profiles };
  const p1Color = m.p1Color ?? prev?.p1Color;
  const result = m.result ?? prev?.result;
  const merged = {
    ...m,
    ...(profiles.p1 || profiles.p2 ? { profiles } : {}),
    ...(p1Color && { p1Color }),
    ...(result && { result }),
  };
  store.set(matchesAtom, upsert(store.get(matchesAtom), merged));
  const cur = store.get(currentMatchAtom);
  if (cur && cur.covenantId === m.covenantId) store.set(currentMatchAtom, merged);
  return merged;
}

/** Store and show a game in one step (new game, taken seat). */
export function openMatch(m: Match): void {
  store.set(currentMatchAtom, updateMatch(m));
}

/** Show an already-stored game. */
export function showMatch(m: Match): void {
  store.set(currentMatchAtom, m);
}

/** Drop a game from the stored list. */
export function removeMatch(covenantId: string): void {
  store.set(
    matchesAtom,
    store.get(matchesAtom).filter((m) => m.covenantId !== covenantId),
  );
}

/**
 * The games this key is sitting in that haven't ended. Its balance is
 * spoken for while any exist (it still owes their fees), and losing the key
 * would strand them — which is what the cash-out reserve and the sign-in
 * warning are each asking about.
 * (An unjoined seat has p2 = ZERO_PK, which no real key can equal, so the
 * open/joined distinction needs no separate test.)
 */
export function unfinishedGamesOn(matches: Match[], pk: string): Match[] {
  return matches.filter((m) => !m.result && (m.state.p1 === pk || m.state.p2 === pk));
}

/** Back to the hub; `forget` also drops the game from the stored list. */
export function exitMatch(forget: boolean): void {
  const cur = store.get(currentMatchAtom);
  if (forget && cur) removeMatch(cur.covenantId);
  store.set(currentMatchAtom, null);
}

export function clearInvite(): void {
  store.set(pendingInviteAtom, null);
}

// Mirror what's on screen into the URL fragment: the address bar is always a
// valid share link, and a refresh or bookmark reopens the same view. An
// invite stays in the URL until it's taken or declined, so refreshing
// mid-prompt re-offers it.
const shownAtom = atom((get) => get(pendingInviteAtom) ?? get(currentMatchAtom));
writeUrlHash(store.get(shownAtom));
store.sub(shownAtom, () => writeUrlHash(store.get(shownAtom)));

// Cross-tab: another tab's saves land here via storage events (which only
// fire in OTHER tabs, and only when the value actually changed — no echo
// loop as long as we adopt without re-saving, hence matchesBase, not
// matchesAtom). The on-screen game follows when the other tab has a fresher
// take on it; a match removed elsewhere stays on screen until the player
// leaves it themselves.
window.addEventListener("storage", (ev) => {
  if (ev.key !== LIST_KEY) return;
  const list = loadMatches();
  store.set(matchesBase, list);
  const cur = store.get(currentMatchAtom);
  if (!cur) return;
  const updated = list.find((m) => m.covenantId === cur.covenantId);
  // fresherOf prefers its first argument on equal moveCount, so a
  // result/profile recorded by the other tab wins over our stale copy.
  if (updated) store.set(currentMatchAtom, fresherOf(updated, cur));
});

// And the reverse: pasting a #g= link into the address bar of an already-open
// page is a same-document navigation — no reload, only a hashchange. Route it
// exactly like a fresh load: a known game reopens (at whichever state is
// fresher, so pasting a link for the on-screen game doubles as a catch-up
// import), an unknown one becomes a pending invite, and a cleared hash
// returns to the hub. The mirror above writes via replaceState, which never
// fires this event — no feedback loop.
window.addEventListener("hashchange", () => {
  const known = knownMatchFromUrl();
  if (known) {
    store.set(pendingInviteAtom, null);
    openMatch(known);
    return;
  }
  const invite = pendingInviteFromUrl();
  if (invite) {
    store.set(currentMatchAtom, null);
    store.set(pendingInviteAtom, invite);
    return;
  }
  // A hash that parses to nothing: an emptied fragment means "back to the
  // hub"; garbage is ignored and the next state change rewrites the URL.
  if (!window.location.hash) {
    store.set(pendingInviteAtom, null);
    store.set(currentMatchAtom, null);
  }
});
