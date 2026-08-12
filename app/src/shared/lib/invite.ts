/**
 * Invite links: a match travels inside the URL fragment as a compact share
 * code (#g=...). These helpers read and write that fragment outside of React.
 */

import { decodeShareCode, encodeShareCode, loadMatches, type Match } from "./match";

/** Pull an invite out of a pasted link/code or a URL fragment. */
export function parseInvite(raw: string): Match | null {
  const text = raw.trim();
  const code = text.includes("#g=") ? text.slice(text.indexOf("#g=") + 3) : text;
  try {
    return decodeShareCode(decodeURIComponent(code));
  } catch {
    return null;
  }
}

/** Full shareable URL for a match. */
export function inviteLink(m: Match): string {
  return `${window.location.origin}${window.location.pathname}#g=${encodeURIComponent(encodeShareCode(m))}`;
}

/** Keep the address bar a valid share link for whatever is on screen (or bare
 * when on the hub), so a refresh or bookmark reopens the same view. */
export function writeUrlHash(shown: Match | null): void {
  const url = shown
    ? `${window.location.pathname}#g=${encodeURIComponent(encodeShareCode(shown))}`
    : window.location.pathname;
  history.replaceState(null, "", url);
}

/**
 * A #g= link to a game we already track reopens that game directly, at our
 * TRACKED state — never at the link's. A #g= link is attacker-controlled input
 * and its state only has to be genesis-reachable, not correspond to the live
 * on-chain UTXO; trusting a link that merely reports higher progress would let
 * an opponent overwrite our real match with a decoy state, pointing the watcher
 * at a never-funded address and blinding us until we forfeit on the clock. Our
 * stored match is what the chain-connected watcher keeps synced, so it is the
 * only safe basis; the watcher advances it, not the link. Pure read — safe in a
 * StrictMode-double-invoked initializer.
 */
export function knownMatchFromUrl(): Match | null {
  const invite = parseInvite(window.location.hash);
  if (!invite) return null;
  return loadMatches().find((m) => m.covenantId === invite.covenantId) ?? null;
}

/** A #g= link to a game we don't track yet becomes a pending invite. */
export function pendingInviteFromUrl(): Match | null {
  const invite = parseInvite(window.location.hash);
  if (!invite) return null;
  return loadMatches().some((m) => m.covenantId === invite.covenantId) ? null : invite;
}
