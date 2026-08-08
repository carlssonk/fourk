import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { ensureFunds } from "@shared/lib/dispenser";
import { CELLS, isOpen } from "@shared/lib/game";
import { inviteLink } from "@shared/lib/invite";
import { fmtKas, isStaked, type Match } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import type { StatusDescriptor } from "@shared/modes/types";
import { playClaimReady, playClockExpired, playClockWarning } from "@shared/lib/sound";
import { DiscLoader } from "@shared/components/DiscLoader";
import {
  RESET_RESULT,
  advanceConnecting,
  askConfirm,
  busyAtom,
  createGame,
  exitMatch,
  getRpc,
  matchWallet,
  newGame,
  profileAtom,
  rpcClientAtom,
  runAction,
  startConnecting,
  updateMatch,
} from "@shared/state";
import { Board, PlayerPanel, ResultOverlay } from "./components";
import { useAutopilot } from "./hooks/useAutopilot";
import { useCapClock } from "./hooks/useCapClock";
import { useMatchWatcher } from "./hooks/useMatchWatcher";
import { useMoveClock } from "./hooks/useMoveClock";
import { resultTone, winningCells } from "./lib";

interface Props {
  match: Match;
}

/** Render a mode's status descriptor: bold segments, tone, spinner. */
const Status = ({ status }: { status: StatusDescriptor }) => {
  const body = status.segments.map((seg, i) =>
    seg.bold ? <b key={i}>{seg.text}</b> : <span key={i}>{seg.text}</span>,
  );
  if (status.spinner)
    return (
      <span className="inline-flex items-center gap-2 text-dim">
        <DiscLoader /> {body}
      </span>
    );
  return <span className={status.tone === "danger" ? "text-red" : undefined}>{body}</span>;
};

export const Game = ({ match }: Props) => {
  const busy = useAtomValue(busyAtom);
  const rpcReady = useAtomValue(rpcClientAtom) !== null;
  const [importVal, setImportVal] = useState("");
  const [copied, setCopied] = useState(false);
  // "View board": the verdict card steps aside to show the final position;
  // the banner and end-game buttons below take over.
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  const s = match.state;
  const mode = modeOf(match);
  // Per-match wallet: after a sign-in, games seated by a retired key stay
  // fully playable — matchWallet finds whichever of our keys holds the seat.
  // No seat means spectating; the empty pk matches neither player (nor the
  // ZERO_PK of an unjoined seat), so every role check below reads right.
  const seat = matchWallet(match);
  const myPk = seat?.myPk ?? "";
  const role = cov.myRole(match, myPk);
  const iAmPlayer = role !== "spectator";
  const open = isOpen(s);
  const full = s.moveCount >= CELLS;
  const staked = isStaked(match);
  const { result, finish, myTurn, needManualImport, importMatch } = useMatchWatcher(match);

  // The obligation clock only runs once something is staked on it — an
  // untouched game has no forfeit deadline by contract (it's dissolvable
  // instead); the mode says when that is (classic: first disc; fourk: the
  // round's first commitment).
  const clock = useMoveClock(match, !open && !full && !result && mode.roundStarted(match));
  // The whole-game limit only bites once joined (sudden_death requires a
  // live match) — surface it so a silent 50/50 split never blindsides
  // someone nursing a winning position.
  const capLeft = useCapClock(match, !open && !result);
  const myProfile = useAtomValue(profileAtom);
  // Own seat falls back to the local profile for games created before
  // profiles existed; opponents without one get pubkey-derived identities.
  const p1Profile = match.profiles?.p1 ?? (role === "p1" && myProfile.name ? myProfile : undefined);
  const p2Profile = match.profiles?.p2 ?? (role === "p2" && myProfile.name ? myProfile : undefined);
  const p1Color = match.p1Color ?? "red";
  const p2Color = p1Color === "red" ? "blue" : "red";

  // Joined but nothing staked yet: the pre-game lobby, where either player
  // may still unwind the match on-chain and both stakes come back.
  const inLobby = mode.inLobby(match) && !result;
  // The joiner's exit is covenant-gated on one move clock (anti-grief) —
  // the same age math as the forfeit clock, counting from the join.
  const withdrawClock = useMoveClock(match, inLobby && role === "p2");
  const withdrawGated = role === "p2" && !withdrawClock.expired;

  // ONE optimistic record for both modes: the column just clicked, keyed to
  // the game UTXO it was played on — any fresh match state (our confirmation
  // or a resync) makes it stale and the chain's truth takes over; a failed
  // transaction rolls it back explicitly. Classic recomputes the optimistic
  // board from it; fourk shows it as the sealed pick.
  const [pending, setPending] = useState<{ onTxid: string; col: number } | null>(null);
  const pendingCol = pending !== null && pending.onTxid === match.txid ? pending.col : null;

  const view = mode.view(match, {
    myPk,
    role,
    clockExpired: clock.expired,
    busy,
    pendingCol,
    result,
  });

  useAutopilot(match, mode, { result, busy, finish });

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

  /** The key for an action that only a player can take. Every caller is
   * already behind a player-only control, so this throwing is a bug guard,
   * not a path the UI offers. */
  const seatKey = () => {
    if (!seat) throw new Error("NOT_SEATED");
    return seat.key;
  };

  const drop = (col: number) => {
    setPending({ onTxid: match.txid, col });
    runAction(async () => {
      try {
        const key = seatKey();
        const rpc = await getRpc();
        const outcome = await mode.actions.drop(rpc, key, match, col);
        if (outcome.kind === "ended") {
          // End on the finished position (lighting up the winning line) —
          // the covenant is terminal, so the watcher will never deliver it.
          finish(outcome.message, outcome.match);
        } else {
          updateMatch(outcome.match);
        }
      } catch (e) {
        // The chain said no — take the pick back and surface the error.
        setPending(null);
        throw e;
      }
    });
  };

  // The timeout door: once the opponent's clock runs out, the compliant
  // player takes the pot. The local clock is an estimate anchored one
  // age-fetch ago, so re-check the age on-chain and translate "too early"
  // into minutes.
  const claimTimeoutWin = () =>
    runAction(async () => {
      const key = seatKey();
      const rpc = await getRpc();
      const mins = await cov.moveClockRemaining(rpc, match);
      if (mins) {
        throw new Error(
          `Your opponent still has about ${mins} minute${mins === 1 ? "" : "s"} to move.`,
        );
      }
      try {
        await mode.actions.claimTimeout(rpc, key, match);
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
  const leaveMatch = async () => {
    if (open && role === "p1") {
      const ok = await askConfirm({
        title: "Call off the game?",
        body: "Nobody has joined yet, so the game is called off and your stake comes back to your balance.",
        confirm: "Call it off",
        danger: true,
      });
      if (!ok) return;
      runAction(async () => {
        const rpc = await getRpc();
        await cov.cancelMatch(rpc, seatKey(), match);
        exitMatch(true);
      });
    } else {
      exitMatch(false);
    }
  };

  const dissolveGame = async () => {
    const ok = await askConfirm(
      role === "p1"
        ? {
            title: "Kick your opponent?",
            body: "Their stake returns and their link stops working. You get a fresh game with a new invite link to share.",
            confirm: "Kick them",
            danger: true,
          }
        : {
            title: "Leave the match?",
            body: "It hasn't started, so it's called off and both stakes return.",
            confirm: "Leave",
            danger: true,
          },
    );
    if (!ok) return;
    runAction(async () => {
      startConnecting(role === "p1" ? "Kicking your opponent" : "Leaving the match", [
        "Connecting to the Kaspa network",
        "Returning both stakes",
      ]);
      const key = seatKey();
      const rpc = await getRpc();
      advanceConnecting();
      // The covenant gates the joiner's exit on one move clock — re-check
      // the age on-chain so a slightly-early click gets minutes, not a
      // sequence-lock rejection.
      if (role === "p2") {
        const mins = await cov.moveClockRemaining(rpc, match);
        if (mins) {
          throw new Error(
            `You can withdraw in about ${mins} minute${mins === 1 ? "" : "s"} — the short wait stops join-and-run griefing.`,
          );
        }
      }
      await ensureFunds(rpc, key, cov.FEE_HEADROOM, { staked: isStaked(match) });
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
  const shown = view.board.shownState;

  // Where the money went, said in balance terms — only for staked games and
  // only to the players in them. Appended to the verdict rather than baked
  // into the ending sentences (resultTone classifies those by substring).
  // A testnet reset returns nothing, so it gets no money line.
  let potLine: string | undefined;
  if (staked && result && iAmPlayer && result !== RESET_RESULT) {
    const tone = resultTone(result);
    potLine =
      tone === "win"
        ? `The ${fmtKas(match.value)} KAS pot is in your balance.`
        : tone === "loss"
          ? `The ${fmtKas(match.value)} KAS pot went to your opponent.`
          : `Your ${fmtKas(open ? match.value : match.value / 2n)} KAS came back to your balance.`;
  }

  return (
    // A full-viewport column (minus the shell's 1rem padding top and bottom
    // and its 2.5rem account header): the seats and status up top, the
    // buttons pinned at the bottom, and the board stretched between.
    <div className="flex min-h-[calc(100dvh-4.5rem)] flex-col">
      {/* The seats flank the status; on narrow screens the status drops to
       * its own line below them. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <PlayerPanel
          pk={s.p1}
          profile={p1Profile}
          color={p1Color}
          isMe={role === "p1"}
          active={view.seats[0].active}
          clock={view.seats[0].showClock ? clock.text : null}
          collisionPriority={view.seats[0].collisionPriority}
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
          ) : (
            <Status status={view.status} />
          )}
          {staked && !result && (
            <div
              className="text-sm text-accent"
              title="Both stakes sit in the pot until the game decides who takes it."
            >
              {open
                ? `${fmtKas(match.value * 2n)} KAS pot once your opponent joins`
                : `Pot: ${fmtKas(match.value)} KAS — winner takes it`}
            </div>
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
          active={view.seats[1].active}
          clock={view.seats[1].showClock ? clock.text : null}
          collisionPriority={view.seats[1].collisionPriority}
        />
      </div>

      {result && !overlayDismissed && (
        <ResultOverlay
          result={result}
          pot={potLine}
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
            {potLine && <span className="block text-sm text-accent">{potLine}</span>}
          </div>
        )}
        <Board
          state={shown}
          interactive={view.board.interactive}
          winningCells={winningCells(shown.board)}
          onDrop={drop}
          p1Color={p1Color}
          nextDisc={view.board.nextDisc}
          {...(view.board.priorityDisc && { priorityDisc: view.board.priorityDisc })}
          {...(view.board.ghostDisc && { ghostDisc: view.board.ghostDisc })}
          myPick={view.board.myPick}
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
        {view.canClaimTimeout && (
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
            onClick={() => void dissolveGame()}
          >
            {role === "p1"
              ? "Kick opponent"
              : withdrawGated && withdrawClock.text
                ? `Withdraw & refund in ${withdrawClock.text}`
                : "Withdraw & refund"}
          </button>
        )}
        {!result && (
          <button className="btn btn-muted" disabled={busy} onClick={() => void leaveMatch()}>
            Leave match
          </button>
        )}
      </div>
    </div>
  );
};
