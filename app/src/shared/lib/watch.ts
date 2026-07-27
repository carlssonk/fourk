/**
 * Push-driven chain watching over the node's existing websocket.
 *
 * subscribeUtxosChanged pushes a notification the moment a watched address
 * gains or loses a UTXO — for a match, every transition (join, move,
 * terminal claim) spends the current game UTXO, so watching the current
 * match address alone catches every kind of change at block-acceptance
 * speed (~hundreds of ms at 10 bps).
 *
 * Reality margins: subscriptions die with the websocket (public nodes drop
 * them routinely), so we re-subscribe on every reconnect; and a slow
 * fallback poll catches anything a notification missed. Ticks are
 * serialized — a notification landing mid-tick marks it dirty and re-runs
 * once, instead of stacking concurrent syncs.
 */

import type { Rpc } from "./covenant";

export function watchAddress(
  rpc: Rpc,
  address: string,
  tick: () => Promise<void>,
  fallbackMs = 10_000,
): () => void {
  let alive = true;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runTick = async () => {
    if (!alive) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      await tick();
    } finally {
      running = false;
      if (dirty && alive) {
        dirty = false;
        void runTick();
      }
    }
  };

  const schedule = () => {
    timer = setTimeout(async () => {
      await runTick();
      if (alive) schedule();
    }, fallbackMs);
  };

  const onNotification = () => void runTick();
  const onConnect = () => {
    // server-side subscription state died with the old socket
    Promise.resolve(rpc.subscribeUtxosChanged([address])).catch(() => {});
    void runTick();
  };

  try {
    rpc.addEventListener("utxos-changed", onNotification);
    rpc.addEventListener("connect", onConnect);
    Promise.resolve(rpc.subscribeUtxosChanged([address])).catch(() => {});
  } catch {
    /* subscription API unavailable — the fallback poll still covers us */
  }
  void runTick();
  schedule();

  return () => {
    alive = false;
    clearTimeout(timer);
    try {
      rpc.removeEventListener("utxos-changed", onNotification);
      rpc.removeEventListener("connect", onConnect);
      Promise.resolve(rpc.unsubscribeUtxosChanged([address])).catch(() => {});
    } catch {
      /* already disconnected */
    }
  };
}
