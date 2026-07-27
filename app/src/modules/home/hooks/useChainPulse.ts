import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { rpcClientAtom } from "@shared/state";

/** Cap a reconnect catch-up jump so it rains a few discs, not hundreds. */
const MAX_BATCH = 36;

/**
 * The chain's heartbeat: calls `onBlocks(n)` as the node's virtual DAA score
 * advances (n ≈ freshly mined blocks, ~10/s on testnet-10), pushed over the
 * existing websocket — the notification carries only a score, so it's cheap.
 * Returns whether the pulse is live: false until the first notification and
 * while disconnected.
 */
export function useChainPulse(onBlocks: (n: number) => void): boolean {
  const rpc = useAtomValue(rpcClientAtom);
  const [live, setLive] = useState(false);
  const callback = useRef(onBlocks);
  callback.current = onBlocks;

  useEffect(() => {
    if (!rpc) return;
    let last: bigint | null = null;
    const onScore = (ev: any) => {
      const raw = ev?.data?.virtualDaaScore ?? ev?.virtualDaaScore;
      if (raw == null) return;
      const score = BigInt(raw);
      const n = last === null ? 1 : Number(score - last);
      last = score;
      if (n <= 0) return;
      setLive(true);
      callback.current(Math.min(n, MAX_BATCH));
    };
    const onDisconnect = () => setLive(false);
    const onConnect = () => {
      // server-side subscription state died with the old socket
      Promise.resolve(rpc.subscribeVirtualDaaScoreChanged()).catch(() => {});
    };
    try {
      rpc.addEventListener("virtual-daa-score-changed", onScore);
      rpc.addEventListener("disconnect", onDisconnect);
      rpc.addEventListener("connect", onConnect);
      Promise.resolve(rpc.subscribeVirtualDaaScoreChanged()).catch(() => {});
    } catch {
      /* subscription API unavailable — live stays false, callers fall back */
    }
    return () => {
      try {
        rpc.removeEventListener("virtual-daa-score-changed", onScore);
        rpc.removeEventListener("disconnect", onDisconnect);
        rpc.removeEventListener("connect", onConnect);
        Promise.resolve(rpc.unsubscribeVirtualDaaScoreChanged()).catch(() => {});
      } catch {
        /* already disconnected */
      }
    };
  }, [rpc]);

  return live;
}
