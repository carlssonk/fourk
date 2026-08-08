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
  matchWallet,
  networkResetAtom,
  rpcClientAtom,
  updateMatch,
} from "@shared/state";

/**
 * Everything that happens to a match without the player touching the screen:
 * an opponent joining, opposing transitions, and ending classification.
 * (Automatic duties — reveals, claims, draw and sudden-death cranks — live
 * in useAutopilot.)
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
  // happened after it, so discovery can usually scan a page or two instead
  // of the whole range back to the persistent checkpoint. In-memory only —
  // if a spend somehow predates it, the persistent checkpoint still covers
  // it on the fallback pass.
  const freshCp = useRef<string | null>(null);

  /** Trace the spend of the current game UTXO: cheap fresh-floor scan first,
   * the persistent checkpoint as the deep fallback. */
  const discover = async (client: NonNullable<typeof rpc>, m: Match) => {
    const fresh = freshCp.current;
    let spend = fresh ? await cov.discoverSpend(client, m, fresh).catch(() => null) : null;
    if (!spend) {
      const low = checkpoint.current ?? loadCheckpoint(m.covenantId);
      if (low && low !== fresh) spend = await cov.discoverSpend(client, m, low).catch(() => null);
    }
    return spend;
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

  // Open phase: watch for a join. The joiner's successor address cannot be
  // enumerated (it embeds their pubkey), so we checkpoint the chain while the
  // game UTXO is alive; when it disappears, we scan the blocks since the
  // checkpoint for the spending tx and lift the pubkey out of its join call.
  // Checkpoints persist per match: a host who closed the tab after sharing
  // the link falls back to the one saved at creation (or the last tick of a
  // previous session), so a join that happened while away is still found.
  useEffect(() => {
    if (!rpc || !open || result || busy || needManualImport) return;
    // Push-driven: the node notifies us the moment the genesis UTXO is spent
    // (the join); a slow fallback poll covers missed notifications.
    return watchAddress(rpc, cov.matchAddress(match), async () => {
      try {
        const cp = await cov.chainCheckpoint(rpc);
        try {
          const { status } = await cov.syncMatch(rpc, match);
          if (status !== "terminated") {
            checkpoint.current = cp;
            saveCheckpoint(match.covenantId, cp);
            return;
          }
          // discover* throws when the checkpoint is too old for the node
          // (pruned) — treated as null inside discover().
          const spend = await discover(rpc, match);
          const joined = spend && (await cov.adoptSpend(rpc, match, spend).catch(() => null));
          if (joined) {
            updateMatch(joined);
          } else if (chainReset) {
            finish(RESET_RESULT);
          } else if (spend?.kind === "cancel") {
            finish(modeOf(match).describeEnd(spend, match, myPk));
          } else {
            setNeedManualImport(true);
          }
        } finally {
          freshCp.current = cp;
        }
      } catch {
        /* transient RPC errors: keep polling */
      }
    });
  }, [rpc, open, result, busy, needManualImport, match, chainReset]);

  // Live phase: follow the opponent's transitions; classify the ending if
  // the game UTXO disappears. Push-driven: every opponent transition spends
  // the current match UTXO, so one subscription on its address catches moves
  // and endings alike. Watched on our own turn too: the opponent can
  // dissolve an unstarted game out from under us, and if we idle past the
  // clock they can claim the timeout — without a watcher the board would sit
  // on "your turn" forever after either.
  useEffect(() => {
    if (!rpc || open || full || result || busy) return;
    return watchAddress(rpc, cov.matchAddress(match), async () => {
      try {
        const cp = await cov.chainCheckpoint(rpc);
        try {
          const { status, match: next } = await cov.syncMatch(rpc, match);
          if (status === "advanced") updateMatch(next);
          else if (status === "current") {
            checkpoint.current = cp;
            saveCheckpoint(match.covenantId, cp);
          } else {
            // Trace the spend and adopt whatever continuation it produced (a
            // blind-phase successor — e.g. a fourk commit — can't be
            // enumerated) before reading "gone" as "over".
            const spend = await discover(rpc, match);
            const adopted = spend && (await cov.adoptSpend(rpc, match, spend).catch(() => null));
            if (adopted) {
              updateMatch(adopted);
              return;
            }
            if (!spend && chainReset) {
              finish(RESET_RESULT);
              return;
            }
            // A continuation spend whose adoption failed — or no spend at all
            // where the mode says continuations can hide (blind phases, index
            // races, an in-flight block) — must never be declared an ending.
            // Skip the tick; the watcher retries.
            const mode = modeOf(match);
            if (mode.classifySpend(spend) === "continuation") return;
            finish(mode.describeEnd(spend, match, myPk), mode.finalSnapshot(spend, match));
          }
        } finally {
          freshCp.current = cp;
        }
      } catch {
        /* transient RPC errors: keep polling */
      }
    });
  }, [rpc, open, full, result, busy, match, chainReset]);

  /** Catch up from a pasted invite link (call inside `runAction`). */
  const importMatch = (text: string) => {
    const m = parseInvite(text);
    if (!m) throw new Error("That doesn't look like an invite link.");
    if (m.covenantId !== match.covenantId) throw new Error("That link is for a different game.");
    updateMatch(m);
    setNeedManualImport(false);
  };

  return { result, finish, myTurn, needManualImport, importMatch };
}
