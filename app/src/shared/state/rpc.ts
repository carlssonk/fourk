import { atom, getDefaultStore } from "jotai";
import type { RpcClient } from "kaspa-wasm";
import { connect } from "../lib/covenant";

/** The live client once connected — subscriptions re-attach off this. */
export const rpcClientAtom = atom<RpcClient | null>(null);

/** Public nodes drop websockets routinely; the SDK auto-reconnects. Surface
 * the gap so a quiet board reads as "reconnecting", not broken. */
const rpcConnectedAtom = atom(false);

/** A pinned node (e.g. ws://localhost:17210) set via VITE_NODE_URL in
 * .env.local — see .env.example. Tried first with a quick probe; unreachable
 * pins fall back to the public resolver, so a stopped dev node costs ~3s,
 * never a broken app. */
const NODE_URL: string | undefined = import.meta.env.VITE_NODE_URL;

async function connectPreferred(): Promise<RpcClient> {
  if (NODE_URL) {
    try {
      return await connect(NODE_URL);
    } catch (e) {
      console.warn(`pinned node ${NODE_URL} unreachable — using the public resolver`, e);
    }
  }
  return connect();
}

let promise: Promise<RpcClient> | undefined;

/** The one RPC connection, kicked off on first call (after initSdk). */
export function getRpc(): Promise<RpcClient> {
  promise ??= connectPreferred().then((client) => {
    const store = getDefaultStore();
    try {
      client.addEventListener("disconnect", () => store.set(rpcConnectedAtom, false));
      client.addEventListener("connect", () => store.set(rpcConnectedAtom, true));
    } catch {
      /* event API unavailable — indicator stays off */
    }
    // The initial connect event fired before these listeners existed.
    store.set(rpcConnectedAtom, true);
    store.set(rpcClientAtom, client);
    return client;
  });
  return promise;
}

/** True when the socket dropped after a successful connect — the SDK is
 * retrying in the background and watchers resume on their own. */
export const reconnectingAtom = atom(
  (get) => get(rpcClientAtom) !== null && !get(rpcConnectedAtom),
);
