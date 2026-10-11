/**
 * One driver for every automatic duty a client performs: fourk's reveals,
 * resolves and win claims; both modes' draw and sudden-death cranks. The
 * semantics are shared — "either client may act; losing the race to the
 * opponent's client is success":
 *
 *   - each action fires once per its guard scope (game UTXO or match)
 *   - optional hold-back delay (reveal etiquette) or dynamic schedule
 *     (sudden death's DAA distance), re-checked on-chain before firing
 *   - a terminal duty counts as done only once the chain accepted a
 *     terminal spend: a mempool taking our transaction proves nothing while
 *     a late continuation can still win the input through another node
 *   - on failure: resync; "advanced" adopts the fresh state and re-arms;
 *     "terminated" leaves the ending to the watcher; anything else re-arms
 *     with a growing backoff. An owed reveal must never die on one error (a
 *     cooling dispenser, a full mempool): only the covenant refusing the
 *     spend locally ("script") is final, because retrying it cannot help.
 *
 * Runs on screen (Game) and in the background (MatchKeepers) for every
 * other unfinished game this browser sits in: duties are owed whether or
 * not the game is open.
 */

import { useEffect, useRef, useState } from "react";
import { getDefaultStore } from "jotai";
import * as cov from "@shared/lib/covenant";
import { classifyFailure } from "@shared/lib/errors";
import type { Match } from "@shared/lib/match";
import { GENERIC_END } from "@shared/modes/common";
import type { GameMode } from "@shared/modes/types";
import { busyAtom, getRpc, matchWallet, reportError, runAction, updateMatch } from "@shared/state";

const RETRY_MS = 3000;
const MAX_RETRY_MS = 60_000;
/** Recheck long waits periodically; wall time is only an estimate of DAA age. */
const MAX_TIMER_MS = 30_000;

const store = getDefaultStore();
let backgroundQueue: Promise<void> = Promise.resolve();

/** Background duties run one at a time and stay out of the way of whatever
 * the player is doing on screen (they share the wallet's UTXOs). Failures
 * stay quiet: the driver retries them. */
function runBackground(task: () => Promise<void>): Promise<void> {
  const run = async () => {
    while (store.get(busyAtom)) await new Promise((r) => setTimeout(r, 500));
    await task().catch((e) => console.warn("background duty failed", e));
  };
  backgroundQueue = backgroundQueue.then(run, run);
  return backgroundQueue;
}

export function useAutopilot(
  match: Match,
  mode: GameMode,
  opts: {
    result: string | null;
    busy: boolean;
    finish: (message: string, final?: Match) => void;
    background?: boolean;
    /** How a terminal duty learns what the chain did (tests substitute it). */
    settle?: typeof cov.awaitSettlement;
  },
): void {
  const [tick, setTick] = useState(0);
  /** action key -> guard id it already fired for. */
  const fired = useRef(new Map<string, string>());
  /** action key -> when its current guard id first became due (delays). */
  const firstDue = useRef(new Map<string, { id: string; since: number }>());
  /** action key -> consecutive failures, for the retry backoff. */
  const failures = useRef(new Map<string, number>());
  /** `${key}@${guardId}` handed to a runner and not finished yet. */
  const queued = useRef(new Set<string>());
  const mounted = useRef(false);
  // Action retries must survive the busy -> idle effect cleanup.
  const retries = useRef(new Set<ReturnType<typeof setTimeout>>());
  const { result, busy, finish, background = false, settle = cov.awaitSettlement } = opts;

  useEffect(() => {
    mounted.current = true;
    const pending = retries.current;
    return () => {
      mounted.current = false;
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (result || (busy && !background)) return;
    // No seat, nothing to automate. Holding one also settles the role:
    // matchWallet only ever returns a wallet whose pk is p1 or p2.
    const seat = matchWallet(match);
    if (!seat) return;
    const myPk = seat.myPk;
    const role = myPk === match.state.p1 ? "p1" : "p2";
    const actions = mode.autoActions(match, { myPk, role });

    let alive = true;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const retryLater = (key: string, guardId: string) => {
      const n = (failures.current.get(key) ?? 0) + 1;
      failures.current.set(key, n);
      const timer = setTimeout(
        () => {
          retries.current.delete(timer);
          if (fired.current.get(key) === guardId) fired.current.delete(key);
          setTick((t) => t + 1);
        },
        Math.min(RETRY_MS * 2 ** (n - 1), MAX_RETRY_MS),
      );
      retries.current.add(timer);
    };

    const fire = (key: string, guardId: string, run: (typeof actions)[number]["run"]) => {
      const slot = `${key}@${guardId}`;
      if (queued.current.has(slot)) return;
      queued.current.add(slot);
      const task = () => attempt();
      const attempt = async () => {
        // Marked when it actually runs: runAction skips a task outright while
        // another action holds the lock, and a skipped duty must stay due.
        fired.current.set(key, guardId);
        const signKey = seat.key;
        let rpc: Awaited<ReturnType<typeof getRpc>> | undefined;
        try {
          rpc = await getRpc();
          // From before the spend: the settlement check replays the chain
          // from here to see which transaction won the game UTXO.
          const low = await cov.chainCheckpoint(rpc);
          const outcome = await run(rpc, signKey, match);
          failures.current.delete(key);
          if (outcome.kind === "advanced") {
            updateMatch(outcome.match);
            return;
          }
          const settled = await settle(rpc, match, low, 30_000);
          if (!mounted.current) return;
          if (!settled) {
            // Nothing settled: if the game UTXO is still there, our spend
            // never landed (evicted, or lost a race that changed nothing):
            // the duty is still owed. Otherwise the watcher takes it from here.
            const synced = await cov.syncMatch(rpc, match).catch(() => null);
            if (synced?.status === "current") retryLater(key, guardId);
            return;
          }
          if (settled.status === "advanced") {
            fired.current.delete(key);
            updateMatch(settled.match);
          } else if (settled.status === "ended") {
            const told = mode.describeEnd(settled.spend, settled.match, myPk);
            finish(
              told === GENERIC_END ? outcome.message : told,
              mode.finalSnapshot(settled.spend, outcome.match ?? settled.match),
            );
          }
        } catch (e) {
          // The opponent's transaction may have crossed ours — adopt
          // whatever the chain says and quietly retry on the fresh state.
          const { status, match: next } = rpc
            ? await cov.syncMatch(rpc, match).catch(() => ({ status: "current" as const, match }))
            : { status: "current" as const, match };
          if (!mounted.current) return;
          if (status === "advanced") {
            fired.current.delete(key);
            updateMatch(next);
            return;
          }
          if (status === "terminated") return; // the watcher classifies the ending
          const failure = classifyFailure(e);
          if (failure === "script") throw e; // the covenant itself says no
          retryLater(key, guardId);
          // Worth telling the player about (an empty dispenser, low funds),
          // but never fatal to the duty.
          if (failure === "other" && !background) reportError(e);
        }
      };
      // Cleared whether or not the runner ran it (runAction skips while busy).
      void (background ? runBackground(task) : runAction(task)).finally(() =>
        queued.current.delete(slot),
      );
    };

    for (const action of actions) {
      const guardId = action.oncePer === "utxo" ? match.txid : match.covenantId;
      if (fired.current.get(action.key) === guardId) continue;

      if (action.scheduleMs) {
        const schedule = async () => {
          try {
            const rpc = await getRpc();
            const ms = await action.scheduleMs!(rpc);
            if (!alive || fired.current.get(action.key) === guardId) return;
            if (ms <= 0) fire(action.key, guardId, action.run);
            else timers.push(setTimeout(schedule, Math.min(ms, MAX_TIMER_MS)));
          } catch {
            if (alive) timers.push(setTimeout(schedule, RETRY_MS));
          }
        };
        void schedule();
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

      fire(action.key, guardId, action.run);
    }

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, mode, result, busy, tick]);
}
