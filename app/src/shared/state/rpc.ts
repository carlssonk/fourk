import { atom, getDefaultStore } from "jotai";
import type { RpcClient } from "kaspa-wasm";
import { connect } from "../lib/covenant";
import { checkNetworkReset } from "./network";

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
/** Consecutive failed connects — drives the backoff and the offline banner. */
export const rpcFailuresAtom = atom(0);

/**
 * The one RPC connection, kicked off on first call (after initSdk).
 *
 * A REJECTED connect must not stay cached: `promise` is cleared on failure
 * so the next call (any user action, or the backoff loop below) retries —
 * one unlucky resolver timeout at startup must not brick the whole session
 * behind a permanently-rejected promise.
 */
export function getRpc(): Promise<RpcClient> {
  if (promise) return promise;
  promise = connectPreferred().then((client) => {
    const store = getDefaultStore();
    try {
      client.addEventListener("disconnect", () => store.set(rpcConnectedAtom, false));
      client.addEventListener("connect", () => {
        store.set(rpcConnectedAtom, true);
        // A reconnect can land on a freshly reset chain (node restarts
        // are how resets arrive) — re-check, not just at startup.
        checkNetworkReset(client);
      });
    } catch {
      /* event API unavailable — indicator stays off */
    }
    // The initial connect event fired before these listeners existed.
    store.set(rpcConnectedAtom, true);
    store.set(rpcClientAtom, client);
    store.set(rpcFailuresAtom, 0);
    checkNetworkReset(client);
    return client;
  });
  promise.catch(() => {
    promise = undefined;
    const store = getDefaultStore();
    store.set(rpcFailuresAtom, store.get(rpcFailuresAtom) + 1);
  });
  return promise;
}

/**
 * Startup wiring (main.tsx): connect, and keep trying on our own clock with
 * a capped backoff — without this, a dead-on-arrival connection would sit
 * until the player happened to click something. Callers of getRpc() during
 * an outage still get a fresh attempt (or its in-flight promise) each time.
 */
export function initRpc(): void {
  const RETRY_CAP_MS = 30_000;
  const tick = (delay: number): void => {
    getRpc().catch(() => {
      setTimeout(() => tick(Math.min(delay * 2, RETRY_CAP_MS)), delay);
    });
  };
  tick(2_000);
}

/** True when the socket dropped after a successful connect — the SDK is
 * retrying in the background and watchers resume on their own. */
export const reconnectingAtom = atom(
  (get) => get(rpcClientAtom) !== null && !get(rpcConnectedAtom),
);
