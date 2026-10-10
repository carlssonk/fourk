import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { CELLS, isOpen } from "@shared/lib/game";
import { parseInvite } from "@shared/lib/invite";
import { loadCheckpoint, saveCheckpoint, type Match } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import { watchAddress } from "@shared/lib/watch";
import {
  RESET_RESULT,
  busyAtom,
  getRpc,
  matchWallet,
  networkResetAtom,
  rpcClientAtom,
  updateMatch,
} from "@shared/state";

/** Consecutive unexplained ticks before we offer a manual catch-up. */
const DESYNC_TICKS = 5;

/**
 * Everything that happens to a match without the player touching the screen:
 * an opponent joining, opposing transitions, and ending classification.
 * (Automatic duties — reveals, claims, draw and sudden-death cranks — live
 * in useAutopilot.)
 *
 * One mechanism for all of it: when the game UTXO is spent, replay the chain
 * from a checkpoint (cov.followChain). That reads only ACCEPTED spends, so a
 * double spend that lost in the DAG is never mistaken for what happened, and
 * it walks through any number of transitions, so an opponent's commit that
 * their reveal spent a second later is followed rather than lost.
 */
export function useMatchWatcher(match: Match) {
  const rpc = useAtomValue(rpcClientAtom);
  const busy = useAtomValue(busyAtom);
  // A detected testnet reset explains every "gone without a trace" below:
  // the game's UTXOs never existed on this chain, so don't ask the player
  // to paste links that can't help.
  const chainReset = useAtomValue(networkResetAtom);
  // Seeded from the record: a reopened finished match shows its real ending.
  const [result, setResult] = useState<string | null>(match.result ?? null);
  const [needManualImport, setNeedManualImport] = useState(false);
  const checkpoint = useRef<string | null>(null);
  // The previous tick's chain tip: any spend that triggered THIS tick
  // happened after it, so the replay can usually scan a page or two instead
  // of the whole range back to the persistent checkpoint. In-memory only —
  // if a spend somehow predates it, the persistent checkpoint still covers
  // it on the fallback pass.
  const freshCp = useRef<string | null>(null);
  // Consecutive ticks where the game UTXO is gone and the chain replay
  // explains nothing. A threshold rides out transient misses (an in-flight
  // block, an index race) before the catch-up import is offered.
  const desyncTicks = useRef(0);

  /** Replay the chain: cheap fresh-floor scan first, the persistent
   * checkpoint as the deep fallback. */
  const follow = async (client: NonNullable<typeof rpc>, m: Match) => {
    const fresh = freshCp.current;
    let followed = fresh ? await cov.followChain(client, m, fresh).catch(() => null) : null;
    if (!followed || followed.status === "unknown") {
      const low = checkpoint.current ?? loadCheckpoint(m.covenantId);
      if (low && low !== fresh)
        followed = (await cov.followChain(client, m, low).catch(() => null)) ?? followed;
    }
    return followed;
  };

  /** Show the ending and record it on the stored match in one step; `final`
   * lets callers land a last board update (e.g. the winning disc) with it. */
  const finish = (text: string, final: Match = match) => {
    updateMatch({ ...final, result: text });
    setResult(text);
  };

  const open = isOpen(match.state);
  const full = match.state.moveCount >= CELLS;
  // Spectators hold no seat: the empty pk is actionable in no game.
  const myPk = matchWallet(match)?.myPk ?? "";
  const myTurn = cov.isActionable(match, myPk) && !open && !full && !result;

  // Push-driven: the node notifies us the moment the game UTXO is spent (a
  // join, a move, an ending); a slow fallback poll covers missed
  // notifications. Watched on our own turn too: the opponent can dissolve an
  // unstarted game out from under us, and if we idle past the clock they can
  // claim the timeout — without a watcher the board would sit on "your turn"
  // forever after either. Checkpoints persist per match: a host who closed
  // the tab after sharing the link falls back to the one saved at creation
  // (or the last tick of a previous session), so a join that happened while
  // away is still found.
  useEffect(() => {
    if (!rpc || result || busy) return;
    return watchAddress(rpc, cov.matchAddress(match), async () => {
      try {
        const cp = await cov.chainCheckpoint(rpc);
        try {
          const { status, match: next } = await cov.syncMatch(rpc, match);
          if (status === "advanced") {
            desyncTicks.current = 0;
            updateMatch(next);
            return;
          }
          if (status === "current") {
            desyncTicks.current = 0;
            checkpoint.current = cp;
            saveCheckpoint(match.covenantId, cp);
            // The sync observed the UTXO alive: keep its acceptance stamp (a
            // fourk2 clock and its commit discovery read it). Guarded, since
            // an unconditional update would re-run this effect forever.
            if (next.acceptedDaa !== undefined && next.acceptedDaa !== match.acceptedDaa)
              updateMatch(next);
            return;
          }
          // Gone, and no enumerable successor holds it: replay the chain.
          const followed = await follow(rpc, match);
          if (followed?.status === "advanced") {
            desyncTicks.current = 0;
            updateMatch(followed.match);
            return;
          }
          if (followed?.status === "ended") {
            desyncTicks.current = 0;
            const mode = modeOf(followed.match);
            finish(
              mode.describeEnd(followed.spend, followed.match, myPk),
              mode.finalSnapshot(followed.spend, followed.match),
            );
            return;
          }
          if (chainReset) {
            finish(RESET_RESULT);
            return;
          }
          // Nothing the chain can explain yet: a spend still waiting for
          // acceptance, or a tracked state that no longer matches the chain
          // (a stale or forged import, a checkpoint the node has pruned past).
          // After a few tolerant ticks, offer the catch-up import instead of
          // watching a dead address in silence.
          if (++desyncTicks.current >= DESYNC_TICKS) setNeedManualImport(true);
        } finally {
          freshCp.current = cp;
        }
      } catch {
        /* transient RPC errors: keep polling */
      }
    });
  }, [rpc, result, busy, match, chainReset, myPk]);

  /** Catch up from a pasted link — believed only once the chain shows its
   * state is this game's live UTXO and fresher than ours (call inside
   * `runAction`). */
  const importMatch = async (text: string) => {
    const m = parseInvite(text);
    if (!m) throw new Error("That doesn't look like an invite link.");
    const verified = await cov.verifyImport(await getRpc(), match, m);
    updateMatch(verified);
    setNeedManualImport(false);
    desyncTicks.current = 0;
  };

  return { result, finish, myTurn, needManualImport, importMatch, open };
}
