import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { ensureFunds } from "@shared/lib/dispenser";
import { applyMove, playerToMove } from "@shared/lib/game";
import { parseInvite } from "@shared/lib/invite";
import { loadCheckpoint, saveCheckpoint, toHex, type Match } from "@shared/lib/match";
import { watchAddress } from "@shared/lib/watch";
import {
  RESET_RESULT,
  busyAtom,
  getRpc,
  getWallet,
  networkResetAtom,
  rpcClientAtom,
  runAction,
  updateMatch,
} from "@shared/state";
import type { MatchView } from "../lib";

/** The stored-match schema requires a real txid — never write anything else. */
function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * Friendly description of a discovered ending. The spend spent exactly
 * `match.txid`, so match.state is the true pre-spend state — whose turn it
 * was identifies who acted, even for doors whose sigscript carries no pubkey
 * (a winning move is the mover's; a forfeit claim is the waiting player's,
 * which may be OUR claim made from another tab or the CLI).
 */
function describeEnd(spend: cov.SpendInfo | null, match: Match, myPk: string): string {
  const s = match.state;
  const moverPk = playerToMove(s) === 0 ? s.p1 : s.p2;
  const waitingPk = playerToMove(s) === 0 ? s.p2 : s.p1;
  switch (spend?.kind) {
    case "winning_move":
      return moverPk === myPk
        ? "You connected four — you win! 🎉"
        : "Your opponent connected four — they win this one.";
    case "claim_forfeit":
      return waitingPk === myPk
        ? "Your opponent ran out of time — you win by timeout. 🎉"
        : "The move timer ran out and your opponent claimed the win.";
    case "claim_draw":
      return "It's a draw — the board filled up with no winner.";
    case "cancel":
      return "The game was called off before anyone joined.";
    case "sudden_death":
      return "Time's up — the game hit its total time limit and the pot split evenly.";
    case "dissolve": {
      // The dissolve call pushes the dissolving player's pubkey — read it to
      // tell a kick from a walk-out.
      const signer = spend.pushes.find((p) => p.length === 32);
      const by = signer ? toHex(signer) : null;
      if (by === myPk) return "The game was dissolved — both stakes returned.";
      if (myPk === match.state.p2 && by === match.state.p1)
        return "Your opponent called the game off — your stake is on its way back.";
      if (myPk === match.state.p1 && by === match.state.p2)
        return "Your opponent left before the game began — your stake is on its way back.";
      return "The game was dissolved before the first move — both stakes returned.";
    }
    default:
      return "The game has ended.";
  }
}

/**
 * Everything that happens to a match without the player touching the screen:
 * an opponent joining, opposing moves, endings, and the automatic draw claim
 * on a full board.
 */
export function useMatchWatcher(match: Match, view: MatchView) {
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
  const drawClaimed = useRef(false);

  /** Show the ending and record it on the stored match in one step; `final`
   * lets callers land a last board update (e.g. the winning disc) with it. */
  const finish = (text: string, final: Match = match) => {
    updateMatch({ ...final, result: text });
    setResult(text);
  };

  const { open, full, iAmPlayer } = view;
  const myTurn = view.wantsMove && !result;

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
    return watchAddress(rpc, cov.gameAddress(match.state), async () => {
      try {
        const cp = await cov.chainCheckpoint(rpc);
        const { status } = await cov.syncMatch(rpc, match);
        if (status !== "terminated") {
          checkpoint.current = cp;
          saveCheckpoint(match.covenantId, cp);
          return;
        }
        const low = checkpoint.current ?? loadCheckpoint(match.covenantId);
        // discover* throws when the checkpoint is too old for the node
        // (pruned) — treat that like no checkpoint at all.
        const joined = low && (await cov.discoverJoin(rpc, match, low).catch(() => null));
        if (joined) {
          updateMatch(joined);
        } else if (chainReset) {
          finish(RESET_RESULT);
        } else if (low) {
          const spend = await cov.discoverSpend(rpc, match, low).catch(() => null);
          if (spend?.kind === "cancel") finish(describeEnd(spend, match, getWallet().myPk));
          else setNeedManualImport(true);
        } else {
          setNeedManualImport(true);
        }
      } catch {
        /* transient RPC errors: keep polling */
      }
    });
  }, [rpc, open, result, busy, needManualImport, match, chainReset]);

  // Live phase: follow the opponent's moves; classify the ending if the game
  // UTXO disappears. Push-driven: every opponent transition spends the
  // current match UTXO, so one subscription on its address catches moves and
  // endings alike. Watched on our own turn too: the opponent can dissolve an
  // unstarted game out from under us, and if we idle past the move timeout
  // they can claim the forfeit — without a watcher the board would sit on
  // "your turn" forever after either.
  useEffect(() => {
    if (!rpc || open || full || result || busy) return;
    return watchAddress(rpc, cov.gameAddress(match.state), async () => {
      try {
        const cp = await cov.chainCheckpoint(rpc);
        const { status, match: next } = await cov.syncMatch(rpc, match);
        if (status === "advanced") updateMatch(next);
        else if (status === "current") {
          checkpoint.current = cp;
          saveCheckpoint(match.covenantId, cp);
        } else {
          const low = checkpoint.current ?? loadCheckpoint(match.covenantId);
          const spend = low ? await cov.discoverSpend(rpc, match, low).catch(() => null) : null;
          if (!spend && chainReset) {
            finish(RESET_RESULT);
            return;
          }
          // A discovered winning move pinpoints the final disc — end on the
          // finished board (which also lights up the winning line), not the
          // position one move earlier. The record's txid advances with it:
          // describeEnd's attribution relies on state matching txid, so a
          // half-updated record would misread the ending on a later reopen.
          let final = match;
          if (spend?.kind === "winning_move" && spend.args.length && isHex64(spend.txid)) {
            try {
              final = { ...match, state: applyMove(match.state, spend.args[0]!), txid: spend.txid };
            } catch {
              /* stale local state — keep the board we have */
            }
          }
          finish(describeEnd(spend, match, getWallet().myPk), final);
        }
      } catch {
        /* transient RPC errors: keep polling */
      }
    });
  }, [rpc, open, full, result, busy, match, chainReset]);

  // A full board settles itself: either player's client claims the draw.
  useEffect(() => {
    if (!full || result || busy || !iAmPlayer || drawClaimed.current) return;
    drawClaimed.current = true;
    runAction(async () => {
      const { key } = getWallet();
      const client = await getRpc();
      try {
        await ensureFunds(client, key, cov.FEE_HEADROOM);
        await cov.drawMatch(client, key, match);
        finish("It's a draw — the board filled up with no winner.");
      } catch (e) {
        // Most likely the opponent's client claimed it first.
        const { status } = await cov.syncMatch(client, match);
        if (status === "terminated") finish("It's a draw — the board filled up with no winner.");
        else throw e;
      }
    });
  }, [full, result, busy, iAmPlayer, match]);

  // A capped game settles itself once the chain passes its deadline: either
  // player's client cranks the permissionless split and both stakes return.
  const suddenDone = useRef(false);
  const deadline = match.state.deadline;
  useEffect(() => {
    if (!rpc || open || result || busy || !iAmPlayer || !deadline || suddenDone.current) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = () => {
      if (stop || suddenDone.current) return;
      suddenDone.current = true;
      runAction(async () => {
        const { key } = getWallet();
        const client = await getRpc();
        try {
          await ensureFunds(client, key, cov.FEE_HEADROOM);
          await cov.suddenDeathMatch(client, key, match);
          finish("Time's up — the game hit its total time limit and the pot split evenly.");
        } catch (e) {
          // Most likely the opponent's client cranked it first.
          const { status } = await cov.syncMatch(client, match);
          if (status === "terminated")
            finish("Time's up — the game hit its total time limit and the pot split evenly.");
          else throw e;
        }
      });
    };
    Promise.resolve(rpc.getBlockDagInfo())
      .then((info: any) => {
        if (stop) return;
        const msLeft = (deadline - Number(info.virtualDaaScore)) * 100;
        // Past-deadline claims fire now; far-future ones are re-armed by the
        // next mount (setTimeout caps at ~24.8 days anyway).
        if (msLeft <= 0) claim();
        else if (msLeft < 2_147_000_000) timer = setTimeout(claim, msLeft + 2000);
      })
      .catch(() => {});
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, open, result, busy, iAmPlayer, deadline, match]);

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
