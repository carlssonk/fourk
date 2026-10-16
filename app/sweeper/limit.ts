/**
 * The per-client rate limit both routes share (sweeper.ts, match.ts): a
 * fixed window per client, keyed by CF-Connecting-IP through the tunnel.
 */

/** Requests are counted per client over this window. */
export const RATE_WINDOW_MS = 60_000;

/** A limiter allowing `limit` requests per client per window: call it once
 * per request; true means refuse this one. Idle clients are forgotten once
 * a window, so the map stays small. */
export function createLimiter(limit: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; since: number }>();
  let swept = now();
  return (client: string): boolean => {
    const t = now();
    if (t - swept >= RATE_WINDOW_MS) {
      for (const [c, h] of hits) if (t - h.since >= RATE_WINDOW_MS) hits.delete(c);
      swept = t;
    }
    const h = hits.get(client);
    if (!h || t - h.since >= RATE_WINDOW_MS) {
      hits.set(client, { count: 1, since: t });
      return false;
    }
    return ++h.count > limit;
  };
}

/** A limit from the environment: a positive whole number, else undefined so
 * the default stands. A typo must never lift a limit (`++count > NaN` is
 * always false), so anything else is ignored, and logged by the caller. */
export function limitFromEnv(raw: string | undefined): number | undefined {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}
