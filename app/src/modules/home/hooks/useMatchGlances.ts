import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { finishedLongAgo, phaseOf, type Match } from "@shared/lib/match";
import { getRpc, getWallet, matchesAtom, removeMatch, updateMatch } from "@shared/state";

/** At-a-glance state of a stored match, from a cheap sync on the home screen. */
export type MatchGlance = "waiting" | "your-turn" | "their-turn" | "finished" | "changed";

function glanceOf(status: cov.SyncStatus, prev: Match, next: Match, myPk: string): MatchGlance {
  if (status === "terminated") {
    // An open game's successor can't be enumerated from here (the joiner's
    // pubkey is unknown) — opening the game runs discovery.
    return phaseOf(prev.state) === 0 ? "changed" : "finished";
  }
  if (phaseOf(next.state) === 0) return "waiting";
  return cov.isMyTurn(next, myPk) ? "your-turn" : "their-turn";
}

/**
 * One cheap sync pass over the stored matches: label each with an at-a-glance
 * status (the move timer is real — "your turn" must be visible from home) and
 * fold any advanced states back into storage. Finished games linger for a
 * grace period (so an away result can still be seen), then prune themselves.
 */
export function useMatchGlances(): Record<string, MatchGlance> {
  const matches = useAtomValue(matchesAtom);
  const [glances, setGlances] = useState<Record<string, MatchGlance>>({});
  // Each match STATE (covenantId:txid) syncs once per mount: our own
  // updateMatch calls change the list identity and would otherwise re-sweep
  // every match each time — while a genuinely advanced match (new txid, e.g.
  // from another tab) still gets a fresh look.
  const synced = useRef(new Set<string>());

  useEffect(() => {
    const pending = matches.filter((m) => !synced.current.has(`${m.covenantId}:${m.txid}`));
    if (!pending.length) return;
    let stale = false;
    (async () => {
      const rpc = await getRpc();
      const { myPk } = getWallet();
      for (const m of pending) {
        const key = `${m.covenantId}:${m.txid}`;
        // A recorded ending is already the answer — no RPC needed.
        if (m.result) {
          synced.current.add(key);
          if (finishedLongAgo(m.covenantId)) removeMatch(m.covenantId);
          else setGlances((g) => ({ ...g, [m.covenantId]: "finished" }));
          continue;
        }
        try {
          const { status, match: next } = await cov.syncMatch(rpc, m);
          if (stale) return;
          synced.current.add(key);
          const glance = glanceOf(status, m, next, myPk);
          if (glance === "finished" && finishedLongAgo(m.covenantId)) {
            removeMatch(m.covenantId);
            continue;
          }
          setGlances((g) => ({ ...g, [m.covenantId]: glance }));
          if (status === "advanced") updateMatch(next);
        } catch {
          /* transient RPC trouble — unlabeled, retried on the next list change */
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [matches]);

  return glances;
}
