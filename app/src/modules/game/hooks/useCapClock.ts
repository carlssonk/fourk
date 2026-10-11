import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { fmtCountdown, fmtDaaDuration, type Match } from "@shared/lib/match";
import { rpcClientAtom } from "@shared/state";

/** testnet-10 mines ~10 blocks/s, so one DAA block ≈ 100ms of clock. */
const MS_PER_DAA = 100;

/**
 * Estimated countdown to the whole-game deadline, distinct from the move
 * clock. Refresh the chain anchor periodically and when returning to the tab.
 * The invite uses coarse text; the game header uses a second-by-second clock.
 */
export function useCapClock(
  match: Match | null,
  active: boolean,
  display: "coarse" | "clock" = "coarse",
): string | null {
  const rpc = useAtomValue(rpcClientAtom);
  const deadline = match?.state.deadline ?? 0;
  const [anchor, setAnchor] = useState<{ daa: number; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setAnchor(null);
    if (!rpc || !active || !deadline) return;
    let stale = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const info = await rpc.getBlockDagInfo();
        if (stale) return;
        const daa = Number(info.virtualDaaScore);
        if (!Number.isFinite(daa)) return;
        const at = Date.now();
        setNow(at);
        setAnchor({ daa, at });
      } catch {
        // Retain an existing estimate and retry at the next refresh.
      } finally {
        pending = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refresh);
    return () => {
      stale = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", refresh);
    };
  }, [rpc, active, deadline]);

  useEffect(() => {
    if (!anchor) return;
    const id = setInterval(() => setNow(Date.now()), display === "clock" ? 1000 : 10_000);
    return () => clearInterval(id);
  }, [anchor, display]);

  if (!active || !deadline || !anchor) return null;
  const left = deadline - anchor.daa - (now - anchor.at) / MS_PER_DAA;
  if (display === "clock") return fmtCountdown((left * MS_PER_DAA) / 1000);
  return left > 600 ? fmtDaaDuration(left) : "any moment";
}
