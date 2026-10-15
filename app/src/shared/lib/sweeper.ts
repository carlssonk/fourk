import { isDoubleWin } from "./game";
import { matchToJson, type Match } from "./match";

/** The payout service on our node (infra/node, app/sweeper). Unset in local
 * development: players' own clients and the Collect button still pay. */
const SWEEPER_URL: string | undefined = import.meta.env?.VITE_SWEEPER_URL;
/** Whether wins are paid even when both players leave. */
export const HAS_SWEEPER = !!SWEEPER_URL;

/**
 * Hand a pending win to the sweeper so the winner is paid even if both
 * players leave. Best effort and silent: the service only pays the winner,
 * and anything it misses is still covered by the players' clients. A 404
 * usually means our node has not indexed the claim yet, so it retries.
 */
export async function registerSweep(m: Match): Promise<void> {
  // A double win is a split the players' clients contest; the service
  // would refuse it.
  if (!SWEEPER_URL || isDoubleWin(m.state.board)) return;
  // Names are not the service's business.
  const body = matchToJson({ ...m, profiles: undefined });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(SWEEPER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 404) return;
    } catch {
      // Offline or the service is down: retry, then give up quietly.
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
