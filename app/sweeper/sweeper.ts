/**
 * The sweeper's core: take pending Fourk wins from players' clients and send
 * each `sweep_win` once its challenge window ends, so a winner is paid even
 * when both players have closed the game.
 *
 * It holds no keys. `sweep_win` is permissionless and the covenant pins its
 * single output to the pending winner, so the worst this process can do is
 * pay the right player or fail. Requests are untrusted: a match is only
 * queued once the chain holds a live game UTXO at the address its full state
 * derives (a forged state derives an empty address), and value and age always
 * come from the chain, never from the request. Players' own clients send the
 * same sweep, so anything dropped here (restart, full queue) is still paid.
 */

import * as engine from "../src/shared/lib/engine";
import { isDoubleWin } from "../src/shared/lib/game";
import { NETWORK_ID, matchFromJson, type Match } from "../src/shared/lib/match";
import { sweepWinMatch } from "../src/shared/modes/fourk2/actions";
import { core2Of, isCore2 } from "../src/shared/modes/fourk2/core";
import { fourk2Engine } from "../src/shared/modes/fourk2/engine";

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_QUEUE = 1000;
/** Per-client requests per window (CF-Connecting-IP through the tunnel). */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 60_000;
export const MAX_ATTEMPTS = 5;

export interface Reply {
  status: number;
  body: string;
}

interface Pending {
  match: Match;
  /** Date.now() at which to look at this match again. */
  nextCheck: number;
  attempts: number;
}

export function createSweeper(rpc: engine.Rpc, now: () => number = Date.now) {
  const queue = new Map<string, Pending>();
  const hits = new Map<string, { count: number; since: number }>();
  let ticking = false;

  function limited(client: string): boolean {
    const t = now();
    const h = hits.get(client);
    if (!h || t - h.since >= RATE_WINDOW_MS) {
      hits.set(client, { count: 1, since: t });
      return false;
    }
    return ++h.count > RATE_LIMIT;
  }

  /** POST /sweep: register a pending win. 202 = queued (or already queued). */
  async function intake(body: string, client: string): Promise<Reply> {
    if (limited(client)) return { status: 429, body: "slow down" };
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { status: 413, body: "too large" };
    let match: Match;
    try {
      match = matchFromJson(body);
    } catch {
      return { status: 400, body: "not a match" };
    }
    if (match.network !== NETWORK_ID) return { status: 400, body: "wrong network" };
    if (match.mode !== "fourk2" || !isCore2(match.simul) || match.simul.pendingWin === 0)
      return { status: 400, body: "no pending win" };
    // A double win is a split, which the players' clients contest; a sweep
    // would only be refused there.
    if (isDoubleWin(match.state.board))
      return { status: 400, body: "double win" };

    const key = `${match.covenantId}:${match.txid}`;
    if (queue.has(key)) return { status: 202, body: "queued" };
    if (queue.size >= MAX_QUEUE) return { status: 503, body: "busy" };

    const entry = await engine.fetchGameUtxo(rpc, fourk2Engine, match);
    // Unknown here: forged, already settled, or not yet indexed on this node
    // (the client retries).
    if (!entry) return { status: 404, body: "no such pending win" };
    // Value from the chain; names are not ours to keep.
    const { profiles: _names, ...verified } = engine.withEntry(match, entry);
    queue.set(key, { match: verified, nextCheck: 0, attempts: 0 });
    return { status: 202, body: "queued" };
  }

  /** Look at every due match once: sweep it, reschedule it, or drop it. */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const [key, p] of queue) {
        if (p.nextCheck > now()) continue;
        try {
          const age = await engine.gameUtxoAge(rpc, fourk2Engine, p.match);
          // Gone: the winner, the loser or a split settled it already.
          if (age === null) {
            queue.delete(key);
            continue;
          }
          const left = core2Of(p.match).revealTimeout - age;
          if (left > 0) {
            // DAA blocks to ms at 10 per second, padded past the lock.
            p.nextCheck = now() + left * 100 + 2000;
            continue;
          }
          await sweepWinMatch(rpc, p.match);
          queue.delete(key);
          console.log(`swept ${p.match.covenantId.slice(0, 8)}`);
        } catch (e) {
          if (++p.attempts >= MAX_ATTEMPTS) {
            queue.delete(key);
            console.error(`gave up on ${p.match.covenantId.slice(0, 8)}: ${String(e)}`);
          } else p.nextCheck = now() + 15_000 * p.attempts;
        }
      }
      // Forget idle clients so the limiter's map stays small.
      for (const [client, h] of hits) if (now() - h.since >= RATE_WINDOW_MS) hits.delete(client);
    } finally {
      ticking = false;
    }
  }

  return { intake, tick, size: () => queue.size };
}
