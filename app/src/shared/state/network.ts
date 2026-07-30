/**
 * Testnet-reset detection: a persisted DAA high-water mark.
 *
 * A reset rewinds the chain's virtual DAA score to near zero, so a connected
 * node reporting a score far below the highest we've ever seen has exactly
 * one explanation. Detection runs on every (re)connect; on a hit it flags
 * the session (App shows a banner, the match watcher stops chasing spends
 * that never happened on this chain) and records an ending on every stored
 * unfinished match — including ones never reopened, which would otherwise
 * sit in the list as playable forever.
 */

import { atom, getDefaultStore } from "jotai";
import type { Rpc } from "../lib/covenant";
import { NETWORK_ID } from "../lib/match";
import { matchesAtom } from "./matches";

const store = getDefaultStore();

/** True after connecting to a chain whose DAA score sits far below the
 * stored high-water mark — the testnet was reset since we last looked. */
export const networkResetAtom = atom(false);

export const RESET_RESULT = "The test network was reset — this game no longer exists.";

// Per-network key: a future network switch starts a fresh watermark.
const WATERMARK_KEY = `fourk.daaHighWater.${NETWORK_ID}`;

/** ~28 hours of chain at 10 blocks/s — far more than any lagging public
 * node, far less than the rewind of a real reset. VITE_RESET_MARGIN shrinks
 * it on a private local chain, where minutes of mining stand in for that
 * day (see localnet/README.md). */
const RESET_MARGIN = Number(import.meta.env?.VITE_RESET_MARGIN ?? 1_000_000);

export function clearNetworkReset(): void {
  store.set(networkResetAtom, false);
}

/** Compare the connected node's DAA score against the watermark; flag a
 * reset and ratchet the mark. Never throws — a failed read just waits for
 * the next connect. */
export async function checkNetworkReset(rpc: Rpc): Promise<void> {
  try {
    const info: any = await rpc.getBlockDagInfo();
    const daa = Number(info.virtualDaaScore);
    if (!Number.isFinite(daa) || daa <= 0) return;
    const stored = Number(localStorage.getItem(WATERMARK_KEY) ?? 0);
    if (stored - daa > RESET_MARGIN) {
      store.set(networkResetAtom, true);
      // Pre-reset games can never advance or terminate on this chain —
      // record their ending now rather than leaving them looking playable.
      store.set(
        matchesAtom,
        store.get(matchesAtom).map((m) => (m.result ? m : { ...m, result: RESET_RESULT })),
      );
    }
    // Ratchet up in normal times; snap down after a reset so the banner
    // greets each device once, not on every visit forever.
    if (daa > stored || stored - daa > RESET_MARGIN)
      localStorage.setItem(WATERMARK_KEY, String(daa));
  } catch {
    /* node didn't answer — the next connect retries */
  }
}
