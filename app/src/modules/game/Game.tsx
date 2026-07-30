import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { ensureFunds } from "@shared/lib/dispenser";
import { applyMove, discOf, findWin, playerToMove, type State } from "@shared/lib/game";
import { inviteLink } from "@shared/lib/invite";
import type { Match } from "@shared/lib/match";
import { playClaimReady, playClockExpired, playClockWarning } from "@shared/lib/sound";
import { DiscLoader } from "@shared/components/DiscLoader";
import {
  advanceConnecting,
  busyAtom,
  createGame,
  exitMatch,
  getRpc,
  getWallet,
  newGame,
  profileAtom,
  rpcClientAtom,
  runAction,
  startConnecting,
  updateMatch,
} from "@shared/state";
import { Board, PlayerPanel, ResultOverlay } from "./components";
import { useCapClock } from "./hooks/useCapClock";
import { useMatchWatcher } from "./hooks/useMatchWatcher";
import { useMoveClock } from "./hooks/useMoveClock";
import { matchView, resultTone, winningCells } from "./lib";

interface Props {
  match: Match;
}

export const Game = ({ match }: Props) => {
  const busy = useAtomValue(busyAtom);
  const rpcReady = useAtomValue(rpcClientAtom) !== null;
  const [importVal, setImportVal] = useState("");
  const [copied, setCopied] = useState(false);
  // "View board": the verdict card steps aside to show the final position;
  // the banner and end-game buttons below take over.
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const s = match.state;
  const view = matchView(match, getWallet().myPk);
  const { open, full, role, iAmPlayer, mover } = view;
  const { result, finish, myTurn, needManualImport, importMatch } = useMatchWatcher(match, view);

  // The move clock only runs once the game has begun — an unmoved game has
  // no forfeit deadline by contract (it's dissolvable instead).
  const clock = useMoveClock(match, !open && !full && !result && s.moveCount > 0);
  // The whole-game limit only bites once joined (sudden_death requires a
  // live match) — surface it so a silent 50/50 split never blindsides
  // someone nursing a winning position.
  const capLeft = useCapClock(match, !open && !result);
  const myProfile = useAtomValue(profileAtom);
  // Own seat falls back to the local profile for games created before
  // profiles existed; opponents without one get pubkey-derived identities.
  const p1Profile = match.profiles?.p1 ?? (role === "p1" && myProfile.name ? myProfile : undefined);
  const p2Profile = match.profiles?.p2 ?? (role === "p2" && myProfile.name ? myProfile : undefined);
  const playing = !open && !result;
  const p1Color = match.p1Color ?? "red";
  const p2Color = p1Color === "red" ? "blue" : "red";

  // Joined but no disc dropped yet: the pre-game lobby, where either player
  // may still unwind the match on-chain and both stakes come back.
  const inLobby = !open && s.moveCount === 0 && !result;
  // The joiner's exit is covenant-gated on one move clock (anti-grief) —
  // the same age math as the forfeit clock, counting from the join.
  const withdrawClock = useMoveClock(match, inLobby && role === "p2");
  const withdrawGated = role === "p2" && !withdrawClock.expired;

  // Clock sounds, one of each per game UTXO: a nudge when your own time
  // runs low, an alarm when it runs out, a chime when the opponent's does
  // (that's the moment the claim button appears).
  const chimed = useRef({ warn: false, out: false, claim: false });
  useEffect(() => {
    chimed.current = { warn: false, out: false, claim: false };
  }, [match.txid]);
  const secondsLeft = clock.secondsLeft;
  useEffect(() => {
    if (secondsLeft === null || result) return;
    const c = chimed.current;
    if (myTurn) {
      const warnAt = Math.min(60, s.moveTimeout / 20); // half the clock, capped at 1 min
      if (secondsLeft > 0 && secondsLeft <= warnAt && !c.warn) {
        c.warn = true;
        playClockWarning();
      }
      if (secondsLeft === 0 && !c.out) {
        c.out = true;
        playClockExpired();
      }
    } else if (iAmPlayer && secondsLeft === 0 && !c.claim) {
      c.claim = true;
      playClaimReady();
    }
  }, [secondsLeft, myTurn, iAmPlayer, result, s.moveTimeout]);

  // The optimistic move: the disc lands the instant the column is clicked,
  // while the transaction confirms in the background. Keyed to the game
  // UTXO it was played on, so any fresh match state — our confirmation or a
  // resync — makes it stale and the chain's truth takes over; a failed
  // transaction rolls it back explicitly.
  const [pending, setPending] = useState<{ onTxid: string; state: State } | null>(null);
  const confirming = pending !== null && pending.onTxid === match.txid;
  const shown = confirming ? pending.state : s;

  const drop = (col: number) => {
    const next = applyMove(s, col);
    const witness = findWin(next.board, discOf(playerToMove(s)));
    setPending({ onTxid: match.txid, state: next });
    runAction(async () => {
      try {
        const { key } = getWallet();
        const rpc = await getRpc();
        if (witness) {
          const txid = await cov.winMatch(rpc, key, match, col, witness);
          // End on the finished position (lighting up the winning line) — the
          // covenant is terminal, so the watcher will never deliver it.
          finish("You connected four — you win! 🎉", { ...match, state: next, txid });
        } else {
          // A move's fee comes off a wallet UTXO; refill from the dispenser
          // if the wallet has run dry mid-game.
          await ensureFunds(rpc, key, cov.FEE_HEADROOM);
          updateMatch(await cov.moveMatch(rpc, key, match, col));
        }
      } catch (e) {
        // The chain said no — take the disc back and surface the error.
        setPending(null);
        throw e;
      }
    });
  };

  // The forfeit door: once the mover's clock runs out, the waiting player
  // takes the pot. The local clock is an estimate anchored one age-fetch ago,
  // so re-check the age on-chain and translate "too early" into minutes.
  const claimTimeoutWin = () =>
    runAction(async () => {
      const { key } = getWallet();
      const rpc = await getRpc();
      const age = await cov.gameUtxoAge(rpc, match);
      if (age !== null && age < s.moveTimeout) {
        const mins = Math.ceil((s.moveTimeout - age) / 600);
        throw new Error(
          `Your opponent still has about ${mins} minute${mins === 1 ? "" : "s"} to move.`,
        );
      }
      try {
        await cov.forfeitMatch(rpc, key, match);
        finish("Your opponent ran out of time — you win by timeout. 🎉");
      } catch (e) {
        // The opponent may have moved (or another claim landed) at the last
        // second — resync instead of surfacing a spent-UTXO error.
        const { status, match: next } = await cov.syncMatch(rpc, match);
        if (status === "advanced") updateMatch(next);
        else if (status !== "terminated") throw e;
      }
    });

  // One exit for every phase: an open game we created is cancelled on-chain
  // (the stake comes back) and forgotten; anything else goes back to the hub
  // but stays under "Open matches".
  const leaveMatch = () => {
    if (open && role === "p1") {
      if (
        !confirm(
          "Leave the match? Nobody has joined yet, so it's called off and your stake returns.",
        )
      )
        return;
      runAction(async () => {
        const rpc = await getRpc();
        await cov.cancelMatch(rpc, getWallet().key, match);
        exitMatch(true);
      });
    } else {
      exitMatch(false);
    }
  };

  const dissolveGame = () => {
    const msg =
      role === "p1"
        ? "Kick your opponent? Their stake returns, their link stops working, and you get a fresh game with a new invite link to share."
        : "Leave the match? It hasn't started, so it's called off and both stakes return.";
    if (!confirm(msg)) return;
    runAction(async () => {
      startConnecting(role === "p1" ? "Kicking your opponent" : "Leaving the match", [
        "Connecting to the Kaspa network",
        "Returning both stakes",
      ]);
      const { key } = getWallet();
      const rpc = await getRpc();
      advanceConnecting();
      // The covenant gates the joiner's exit on one move clock — re-check
      // the age on-chain so a slightly-early click gets minutes, not a
      // sequence-lock rejection.
      if (role === "p2") {
        const age = await cov.gameUtxoAge(rpc, match);
        if (age !== null && age < s.moveTimeout) {
          const mins = Math.ceil((s.moveTimeout - age) / 600);
          throw new Error(
            `You can withdraw in about ${mins} minute${mins === 1 ? "" : "s"} — the short wait stops join-and-run griefing.`,
          );
        }
      }
      await ensureFunds(rpc, key, cov.FEE_HEADROOM);
      await cov.dissolveMatch(rpc, key, match);
      exitMatch(true);
      // A kick reads as "clear the seat", not "destroy the match". On-chain
      // it must be a new covenant — a dead link is exactly what keeps the
      // kicked player out — so flow straight into hosting a fresh game with
      // a new link to share.
      if (role === "p1") await createGame();
    });
  };

  const link = inviteLink(match);

  return (
    // A full-viewport column (the app shell pads 1rem top and bottom): the
    // seats and status up top, the buttons pinned at the bottom, and the
    // board stretched across everything in between.
    <div className="flex min-h-[calc(100dvh-2rem)] flex-col">
      {/* The seats flank the status; on narrow screens the status drops to
       * its own line below them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <PlayerPanel
          pk={s.p1}
          profile={p1Profile}
          color={p1Color}
          isMe={role === "p1"}
          active={playing && !full && mover === 0}
          clock={mover === 0 ? clock.text : null}
        />
        <div className="order-3 w-full text-center sm:order-0 sm:w-auto sm:min-w-0 sm:flex-1">
          {!rpcReady && !result ? (
            <span className="inline-flex items-center gap-2 text-dim">
              <DiscLoader /> Connecting to the game…
            </span>
          ) : open ? (
            <span>Waiting for your opponent to join…</span>
          ) : result ? (
            <span>Game over</span>
          ) : full ? (
            <span>Board full…</span>
          ) : confirming ? (
            // The optimistic disc is already on the board — saying "your
            // turn" now would invite a second click that can't go through.
            <span className="inline-flex items-center gap-2 text-dim">
              <DiscLoader /> Confirming your move…
            </span>
          ) : myTurn && clock.expired ? (
            <span className="text-red">
              <b>Your time is up</b> — your opponent can claim the win. Move now!
            </span>
          ) : myTurn ? (
            <span>
              {s.moveCount === 0 ? (
                <>
                  <b>Your opponent joined</b> — drop a disc to start
                </>
              ) : (
                <>
                  <b>Your turn</b> — drop a disc
                </>
              )}
            </span>
          ) : iAmPlayer && s.moveCount === 0 ? (
            <span>Waiting for your opponent to start…</span>
          ) : (
            <span>
              {iAmPlayer
                ? "Opponent's turn…"
                : `${(mover === 0 ? p1Color : p2Color) === "red" ? "Red" : "Blue"} to move`}
            </span>
          )}
          {capLeft && (
            <div
              className="text-sm text-dim"
              title="This game has a total time limit. If it's still unfinished when the limit hits, the pot splits evenly and both stakes return."
            >
              ⌛ pot splits in {capLeft} if unfinished
            </div>
          )}
        </div>
        <PlayerPanel
          pk={s.p2}
          profile={p2Profile}
          color={p2Color}
          isMe={role === "p2"}
          active={playing && !full && mover === 1}
          clock={mover === 1 ? clock.text : null}
        />
      </div>

      {result && !overlayDismissed && (
        <ResultOverlay
          result={result}
          tone={resultTone(result)}
          busy={busy}
          onPlayAgain={() => {
            exitMatch(true);
            newGame();
          }}
          onExit={() => exitMatch(true)}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}

      {open && role === "p1" && !needManualImport && (
        <div className="card mx-auto mt-3 w-full max-w-175 px-4 py-3">
          <p className="mb-1.5 text-sm text-dim">
            Send this link to your opponent — the game starts the moment they take their seat:
          </p>
          <div className="flex items-center gap-2">
            <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      {needManualImport && (
        <div className="card mx-auto mt-3 w-full max-w-175 px-4 py-3.5">
          <h2 className="mb-2 text-base font-semibold text-accent">
            Hmm — the game moved without us
          </h2>
          <p className="text-sm text-dim">
            Something updated this game while this page wasn't watching. Paste the invite link from
            your opponent to catch up.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              className="input"
              value={importVal}
              onChange={(e) => setImportVal(e.target.value)}
              placeholder="invite link…"
            />
            <button
              className="btn"
              disabled={!importVal.trim()}
              onClick={() =>
                runAction(async () => {
                  importMatch(importVal);
                  setImportVal("");
                })
              }
            >
              Catch up
            </button>
          </div>
          {/* Always an exit: without a link this state has no other way out
           * (e.g. the game predates a testnet reset and no link can help). */}
          <button className="btn btn-muted mt-2.5" onClick={() => exitMatch(true)}>
            Give up on this game
          </button>
        </div>
      )}

      {/* The board owns whatever height the bars above and below leave. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center py-3">
        {/* Floating over the board's slack space instead of in the column
         * flow, so appearing (after "View board") never shifts the layout. */}
        {result && overlayDismissed && (
          <div className="absolute top-1 left-1/2 z-10 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-lg border border-ok bg-panel/80 px-3.5 py-2 text-center backdrop-blur-xs">
            {result}
          </div>
        )}
        <Board
          state={shown}
          interactive={myTurn && !busy && !confirming}
          winningCells={winningCells(shown.board)}
          onDrop={drop}
          p1Color={p1Color}
          nextDisc={playing && !full ? (discOf(playerToMove(shown)) as 1 | 2) : null}
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        {result && overlayDismissed && (
          <button
            className="btn"
            onClick={() => {
              exitMatch(true);
              newGame();
            }}
          >
            Play again
          </button>
        )}
        {result && overlayDismissed && (
          <button className="btn btn-muted" onClick={() => exitMatch(true)}>
            Back to start
          </button>
        )}
        {!open && !full && !myTurn && iAmPlayer && !result && s.moveCount > 0 && clock.expired && (
          <button className="btn" disabled={busy} onClick={claimTimeoutWin}>
            Time's up — claim the win
          </button>
        )}
        {inLobby && iAmPlayer && (
          <button
            className="btn btn-danger"
            disabled={busy || withdrawGated}
            title={
              withdrawGated
                ? "The covenant lets the joiner withdraw after one move clock — the wait stops join-and-run lobby griefing."
                : undefined
            }
            onClick={dissolveGame}
          >
            {role === "p1"
              ? "Kick opponent"
              : withdrawGated && withdrawClock.text
                ? `Withdraw & refund in ${withdrawClock.text}`
                : "Withdraw & refund"}
          </button>
        )}
        {!result && (
          <button className="btn btn-muted" disabled={busy} onClick={leaveMatch}>
            Leave match
          </button>
        )}
      </div>
    </div>
  );
};
