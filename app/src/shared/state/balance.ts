/**
 * The active account's balance, kept fresh by a slow poll, a refresh on
 * focus, and explicit refreshes after every action. One address is cheap
 * enough that polling beats a UTXO subscription that has to be re-attached
 * on every reconnect.
 */

import { atom, getDefaultStore } from "jotai";
import { walletAddress, walletBalance } from "../lib/covenant";
import { rpcClientAtom } from "./rpc";
import { ownedWallet } from "./wallet";

const store = getDefaultStore();

/** The owned account's balance in sompi; null while it's still loading or
 * while the player is a guest (whose dispenser-funded seat has no balance
 * worth showing — that's the whole point of free mode). */
export const balanceAtom = atom<bigint | null>(null);

export function getBalance(): bigint | null {
  return store.get(balanceAtom);
}

let refreshing = false;

/** Re-read the balance; concurrent calls collapse into one. */
export async function refreshBalance(): Promise<void> {
  // The rpc check comes first: it is only ever set after the wasm SDK is
  // initialized, so nothing here can construct a key too early.
  const rpc = store.get(rpcClientAtom);
  if (!rpc || refreshing) return;
  const owned = ownedWallet();
  if (!owned) return;
  refreshing = true;
  try {
    store.set(balanceAtom, await walletBalance(rpc, walletAddress(owned.key)));
  } catch {
    /* transient RPC hiccup — the next refresh wins */
  } finally {
    refreshing = false;
  }
}

// --- Wiring (called once from initStateLayer) --------------------------------

/** Slow enough to be free, fast enough that a deposit shows up while the
 * player is still looking at the screen. Every trigger below no-ops for
 * guests and before the rpc exists. */
const POLL_MS = 10_000;

export function startBalancePolling(): void {
  setInterval(() => void refreshBalance(), POLL_MS);
  window.addEventListener("focus", () => void refreshBalance());
  // First connection (and any reconnect that swaps the client): show a number
  // straight away rather than waiting out a poll.
  store.sub(rpcClientAtom, () => void refreshBalance());
}
