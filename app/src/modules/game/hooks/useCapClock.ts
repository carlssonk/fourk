import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { fmtDaaDuration, type Match } from "@shared/lib/match";
import { rpcClientAtom } from "@shared/state";

/** testnet-10 mines ~10 blocks/s, so one DAA block ≈ 100ms of clock. */
const MS_PER_DAA = 100;

/**
 * Coarse countdown to a capped game's sudden-death deadline — the whole-game
 * limit, distinct from the per-move clock. One DAA anchor per game screen is
 * enough: the chain ticks at a steady ~10 blocks/s and the display is
 * minutes/hours grained. Null while uncapped, inactive, or before the anchor
 * arrives; "any moment" once the deadline has passed (the auto-crank in
 * useMatchWatcher settles it).
 */
export function useCapClock(match: Match, active: boolean): string | null {
  const rpc = useAtomValue(rpcClientAtom);
  const deadline = match.state.deadline;
  const [anchor, setAnchor] = useState<{ daa: number; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setAnchor(null);
    if (!rpc || !active || !deadline) return;
    let stale = false;
    Promise.resolve(rpc.getBlockDagInfo())
      .then((info: any) => {
        if (stale) return;
        setNow(Date.now());
        setAnchor({ daa: Number(info.virtualDaaScore), at: Date.now() });
      })
      .catch(() => {
        /* transient RPC error — the next mount re-anchors */
      });
    return () => {
      stale = true;
    };
  }, [rpc, active, deadline]);

  useEffect(() => {
    if (!anchor) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [anchor]);

  if (!active || !deadline || !anchor) return null;
  const left = deadline - anchor.daa - (now - anchor.at) / MS_PER_DAA;
  return left > 600 ? fmtDaaDuration(left) : "any moment";
}
