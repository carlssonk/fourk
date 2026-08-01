/**
 * One driver for every automatic duty a client performs: fourk's reveals,
 * resolves and win claims; both modes' draw and sudden-death cranks. The
 * semantics are shared — "either client may act; losing the race to the
 * opponent's client is success":
 *
 *   - each action fires once per its guard scope (game UTXO or match)
 *   - optional hold-back delay (reveal etiquette) or dynamic schedule
 *     (sudden death's DAA distance), re-checked whenever the match advances
 *   - on failure: resync; "advanced" adopts the fresh state and re-arms;
 *     "terminated" finishes with the action's message (someone else cranked
 *     the same door) or stays silent for the watcher to classify; a crossed
 *     transaction re-arms after a short pause; anything else surfaces in
 *     the error banner.
 */

import { useEffect, useRef, useState } from "react";
import * as cov from "@shared/lib/covenant";
import type { Match } from "@shared/lib/match";
import type { GameMode } from "@shared/modes/types";
import { getRpc, getWallet, runAction, updateMatch } from "@shared/state";

const CROSSED = /game UTXO not found|orphan|already spent|missing outpoint/i;
/** setTimeout's cap (~24.8 days); longer schedules re-arm on a later mount. */
const MAX_TIMER_MS = 2_147_000_000;

export function useAutopilot(
  match: Match,
  mode: GameMode,
  opts: {
    result: string | null;
    busy: boolean;
    finish: (message: string, final?: Match) => void;
  },
): void {
  const [tick, setTick] = useState(0);
  /** action key -> guard id it already fired for. */
  const fired = useRef(new Map<string, string>());
  /** action key -> when its current guard id first became due (delays). */
  const firstDue = useRef(new Map<string, { id: string; since: number }>());
  const { result, busy, finish } = opts;

  useEffect(() => {
    if (result || busy) return;
    const myPk = getWallet().myPk;
    const role = cov.myRole(match, myPk);
    if (role === "spectator") return;
    const actions = mode.autoActions(match, { myPk, role });

    let alive = true;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const fire = (key: string, guardId: string, run: (typeof actions)[number]["run"], onTerminated?: string) => {
      fired.current.set(key, guardId);
      runAction(async () => {
        const { key: signKey } = getWallet();
        const rpc = await getRpc();
        try {
          const outcome = await run(rpc, signKey, match);
          if (outcome.kind === "advanced") updateMatch(outcome.match);
          else finish(outcome.message, outcome.match ?? match);
        } catch (e) {
          // The opponent's transaction may have crossed ours — adopt
          // whatever the chain says and quietly retry on the fresh state.
          const { status, match: next } = await cov
            .syncMatch(rpc, match)
            .catch(() => ({ status: "current" as const, match }));
          if (status === "advanced") {
            fired.current.delete(key);
            updateMatch(next);
            return;
          }
          if (status === "terminated") {
            if (onTerminated) finish(onTerminated);
            return; // otherwise the watcher classifies the ending
          }
          if (!CROSSED.test(String((e as any)?.message ?? e))) throw e;
          setTimeout(() => {
            fired.current.delete(key);
            setTick((n) => n + 1);
          }, 3000);
        }
      });
    };

    for (const action of actions) {
      const guardId = action.oncePer === "utxo" ? match.txid : match.covenantId;
      if (fired.current.get(action.key) === guardId) continue;

      if (action.scheduleMs) {
        void (async () => {
          try {
            const rpc = await getRpc();
            const ms = await action.scheduleMs!(rpc);
            if (!alive || fired.current.get(action.key) === guardId) return;
            if (ms <= 0) fire(action.key, guardId, action.run, action.onTerminated);
            else if (ms < MAX_TIMER_MS)
              timers.push(
                setTimeout(() => fire(action.key, guardId, action.run, action.onTerminated), ms),
              );
          } catch {
            /* transient RPC trouble — re-armed by the next mount/advance */
          }
        })();
        continue;
      }

      const delay = action.delayMs ?? 0;
      if (delay > 0) {
        const now = Date.now();
        const seen = firstDue.current.get(action.key);
        if (seen?.id !== guardId) firstDue.current.set(action.key, { id: guardId, since: now });
        const left = delay - (now - firstDue.current.get(action.key)!.since);
        if (left > 0) {
          timers.push(setTimeout(() => setTick((n) => n + 1), left));
          continue;
        }
      }

      fire(action.key, guardId, action.run, action.onTerminated);
    }

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, mode, result, busy, tick]);
}
