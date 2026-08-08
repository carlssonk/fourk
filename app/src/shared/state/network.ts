/**
 * Testnet-reset detection: a persisted DAA high-water mark.
 *
 * A reset rewinds the chain's virtual DAA score to near zero, so a connected
 * node reporting a score far below the highest we've ever seen suggests the
 * testnet was reset since we last looked. But one reading is a suspicion,
 * not a verdict — a syncing, buggy, or hostile node can serve a low score,
 * and acting on it stamps an irreversible ending onto every stored match.
 * So a low reading must be CONFIRMED before anything is written: the same
 * node again after a beat (a syncing node's score climbs), plus a second
 * independently-resolved node when one can be had. Detection runs on every
 * (re)connect; on a confirmed hit it flags the session (App shows a banner,
 * the match watcher stops chasing spends that never happened on this chain)
 * and records an ending on every stored unfinished match — including ones
 * never reopened, which would otherwise sit in the list as playable forever.
 */

import { atom, getDefaultStore } from "jotai";
import { connect, type Rpc } from "../lib/covenant";
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

async function readDaa(rpc: Rpc): Promise<number | null> {
  const info: any = await rpc.getBlockDagInfo();
  const daa = Number(info.virtualDaaScore);
  return Number.isFinite(daa) && daa > 0 ? daa : null;
}

/**
 * Corroborate a suspected reset before it becomes a verdict. Conservative
 * by design: any reading that does NOT look reset aborts (the next connect
 * re-checks), and only a node that repeats itself — ideally seconded by an
 * independently-resolved one — is believed.
 */
async function confirmReset(rpc: Rpc, watermark: number): Promise<boolean> {
  // The same node again, after a beat: a node mid-sync climbs fast, and a
  // transient nonsense answer won't repeat.
  await new Promise((r) => setTimeout(r, 5_000));
  try {
    const again = await readDaa(rpc);
    if (again === null || watermark - again <= RESET_MARGIN) return false;
  } catch {
    return false;
  }
  // A second opinion from a fresh resolver connection, when one can be had
  // (a pinned private chain has no resolver — the double-read above is the
  // whole check there, and that node is the operator's own).
  try {
    const second: any = await connect();
    try {
      const other = await readDaa(second);
      if (other !== null && watermark - other <= RESET_MARGIN) return false;
    } finally {
      try {
        second.disconnect?.();
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no second opinion available */
  }
  return true;
}

/** Compare the connected node's DAA score against the watermark; flag a
 * confirmed reset and ratchet the mark. Never throws — a failed read just
 * waits for the next connect. */
export async function checkNetworkReset(rpc: Rpc): Promise<void> {
  // Mainnet does not reset. A rewound score there is a lying or broken
  // node, never a chain event — and stamping every match dead over it
  // would be pure damage.
  if (NETWORK_ID === "mainnet") return;
  try {
    const daa = await readDaa(rpc);
    if (daa === null) return;
    const stored = Number(localStorage.getItem(WATERMARK_KEY) ?? 0);
    if (stored - daa > RESET_MARGIN) {
      if (!(await confirmReset(rpc, stored))) return;
      store.set(networkResetAtom, true);
      // Pre-reset games can never advance or terminate on this chain —
      // record their ending now rather than leaving them looking playable.
      store.set(
        matchesAtom,
        store.get(matchesAtom).map((m) => (m.result ? m : { ...m, result: RESET_RESULT })),
      );
      // Snap the watermark down only after confirmation, so the banner
      // greets each device once — and so an unconfirmed low reading leaves
      // the evidence in place for the next connect to re-examine.
      localStorage.setItem(WATERMARK_KEY, String(daa));
    } else if (daa > stored) {
      localStorage.setItem(WATERMARK_KEY, String(daa));
    }
  } catch {
    /* node didn't answer — the next connect retries */
  }
}
