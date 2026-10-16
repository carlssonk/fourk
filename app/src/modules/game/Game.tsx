import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { ensureFunds } from "@shared/lib/dispenser";
import { CELLS, ROWS, heightOf, isOpen } from "@shared/lib/game";
import { isStaleMatchError } from "@shared/lib/errors";
import { inviteLink } from "@shared/lib/invite";
import { fmtDaaDuration, fmtKas, isStaked, loadCheckpoint, type Match } from "@shared/lib/match";
import { gameEnd } from "@shared/lib/result";
import { HAS_SWEEPER, registerSweep } from "@shared/lib/sweeper";
import { modeOf } from "@shared/modes/registry";
import { isCore2, isQuick } from "@shared/modes/fourk2/core";
import type { StatusDescriptor } from "@shared/modes/types";
import { playClaimReady, playClockExpired, playClockWarning } from "@shared/lib/sound";
import { DiscLoader } from "@shared/components/DiscLoader";
import { useCopy } from "@shared/components/useCopy";
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
import { GameHeader } from "./components/GameHeader";
import { useAutopilot } from "./hooks/useAutopilot";
import { useCapClock } from "./hooks/useCapClock";
import { useMatchWatcher } from "./hooks/useMatchWatcher";
import { useMoveClock } from "./hooks/useMoveClock";
import { winningCells } from "./lib";

interface Props {
  match: Match;
}

/** Render a mode's status descriptor: bold segments, tone, spinner. */
const Status = ({ status }: { status: StatusDescriptor }) => {
  const [headline, ...details] = status.segments;
  return (
    <div className={status.tone === "danger" ? "text-red" : undefined}>
      <div className="flex items-center justify-center gap-2 text-base font-semibold sm:text-lg">
        {status.spinner && <DiscLoader />}
        <span>{headline?.text}</span>
      </div>
      {details.length > 0 && (
        <p className={`mt-0.5 text-sm ${status.tone === "danger" ? "" : "text-dim"}`}>
          {details
            .map((seg) => seg.text)
            .join("")
            .replace(/^[.\s]+/, "")}
        </p>
      )}
    </div>
  );
};

export const Game = ({ match }: Props) => {
  const busy = useAtomValue(busyAtom);
  const rpcReady = useAtomValue(rpcClientAtom) !== null;
  const [importVal, setImportVal] = useState("");
  const { copied, copyError, copy } = useCopy();

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
  const ending = gameEnd(match, myPk, result);
  // Hand a pending win to the payout service, so the winner is paid even if
  // both players leave before its challenge window ends.
  const pendingWin = isCore2(match.simul) ? match.simul.pendingWin : 0;
  useEffect(() => {
    if (pendingWin && iAmPlayer && !result) void registerSweep(match);
    // Once per pending game UTXO, not on every re-render of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.txid, pendingWin]);
  // Dismissing the verdict card reveals the final position; the banner and
  // end-game buttons below take over. A game that was already over when
  // opened (e.g. from Your matches, which shows the outcome) starts that
  // way: the card is for an ending that happens while you watch.
  const [overlayDismissed, setOverlayDismissed] = useState(() => ending !== null);
  // Do not pass the visual ending to the watcher/autopilot: they must still
  // settle the match. Leaving early retains the record so collection can resume.
  const leaveEndedGame = () => exitMatch(!!result);
  const playAgain = () => {
    leaveEndedGame();
    newGame();
  };

  // The obligation clock only runs once something is staked on it — an
  // untouched game has no forfeit deadline by contract (it's dissolvable
  // instead); the mode says when that is (classic: first disc; fourk: the
  // round's first commitment).
  const clock = useMoveClock(match, !open && !full && !ending && mode.roundStarted(match));
  // The whole-game limit only bites once joined (sudden_death requires a
  // live match) — surface it so a silent 50/50 split never blindsides
  // someone nursing a winning position.
  const capLeft = useCapClock(match, !open && !ending, "clock");
  const myProfile = useAtomValue(profileAtom);
  // Own seat falls back to the local profile for games created before
  // profiles existed; opponents without one get pubkey-derived identities.
  const p1Profile = match.profiles?.p1 ?? (role === "p1" && myProfile.name ? myProfile : undefined);
  const p2Profile = match.profiles?.p2 ?? (role === "p2" && myProfile.name ? myProfile : undefined);
  const p1Color = match.p1Color ?? "red";
  const p2Color = p1Color === "red" ? "blue" : "red";

  // Before the first move or sealed pick, either player can unwind the match.
  // P1 can kick immediately; P2 must wait one move clock to prevent instant
  // join-and-cancel abuse. In staked games both stakes come back. The UI used
  // to hide the kick for one clock so it would not read as an accusation, but
  // that left a host with no exit from a guest who joined and idled, so it
  // now mirrors the covenant.
  const inLobby = mode.inLobby(match) && !result;
  // The joiner's exit waits out the mode's lobby clock (none in Quick Match).
  const exitWait = role === "p2" ? mode.joinerExitWait(match) : 0;
  const lobbyClock = useMoveClock(match, inLobby && exitWait > 0, {
    kind: "age",
    daa: exitWait,
  });
  const withdrawGated = exitWait > 0 && !lobbyClock.expired;

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
    clockSecondsLeft: clock.secondsLeft,
    busy,
    pendingCol,
    result: ending?.message ?? result,
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

  /** Submit a drop against a specific match state, routing the outcome. */
  const submitDrop = async (m: Match, col: number) => {
    const key = seatKey();
    const rpc = await getRpc();
    const low = await cov.chainCheckpoint(rpc);
    const outcome = await mode.actions.drop(rpc, key, m, col);
    if (outcome.kind === "continued") {
      updateMatch(outcome.match);
      return;
    }
    // A winning drop ends the game only once the chain took it: a timeout
    // claim by the opponent can still win the input through another node.
    const settled = await cov.awaitSettlement(rpc, m, low, 30_000);
    if (settled?.status === "ended") {
      // End on the finished position (lighting up the winning line) — the
      // covenant is terminal, so the watcher will never deliver it.
      const ours = settled.spend.kind === "winning_move";
      finish(
        ours ? outcome.message : mode.describeEnd(settled.spend, m, myPk),
        ours ? outcome.match : mode.finalSnapshot(settled.spend, m),
      );
    } else if (settled?.status === "advanced") updateMatch(settled.match);
  };

  /** After a lost race for the game UTXO: wait for the winning transition
   * to land and follow the chain to it. Null if the game ended instead or
   * nothing showed up in time. */
  const catchUp = async (from: Match): Promise<Match | null> => {
    const rpc = await getRpc();
    const checkpoint = loadCheckpoint(from.covenantId);
    for (let attempt = 0; attempt < 40; attempt++) {
      const synced = await cov.syncMatch(rpc, from);
      if (synced.status === "advanced") return synced.match;
      if (synced.status === "terminated" && checkpoint) {
        const followed = await cov.followChain(rpc, from, checkpoint).catch(() => null);
        if (followed?.status === "advanced") return followed.match;
        if (followed?.status === "ended") return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  };

  const drop = (col: number) => {
    setPending({ onTxid: match.txid, col });
    runAction(async () => {
      // A stale-UTXO rejection (or a lost race the chain reports) means the
      // pick raced another transition — usually the opponent's commit landing
      // first, which a Fourk second pick must be rebuilt on. The pick itself
      // is still what the player wants: follow the chain and replay it,
      // repeatedly if the race recurs, while it still fits (column open, our
      // move). Speed matters: near the cutoff the rebuilt pick has the rebase
      // grace (~10 s after the opponent's pick) to be accepted.
      let target = match;
      for (let attempt = 0; ; attempt++) {
        try {
          await submitDrop(target, col);
          return;
        } catch (e) {
          if (!isStaleMatchError(String((e as Error)?.message ?? e)) || attempt >= 4) {
            setPending(null);
            throw e;
          }
          const next = await catchUp(target);
          if (next) updateMatch(next);
          const replayable =
            next !== null && cov.isActionable(next, myPk) && heightOf(next.state.board, col) < ROWS;
          if (!replayable) {
            setPending(null);
            throw e;
          }
          setPending({ onTxid: next.txid, col });
          target = next;
        }
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
      const mins = await cov.moveClockRemaining(rpc, match, mode.clock(match));
      if (mins) {
        throw new Error(
          `Your opponent still has about ${mins} minute${mins === 1 ? "" : "s"} to move.`,
        );
      }
      const low = await cov.chainCheckpoint(rpc);
      try {
        await mode.actions.claimTimeout(rpc, key, match);
      } catch (e) {
        // The opponent may have moved (or another claim landed) at the last
        // second — resync instead of surfacing a spent-UTXO error.
        const { status, match: next } = await cov.syncMatch(rpc, match);
        if (status === "advanced") updateMatch(next);
        else if (status !== "terminated") throw e;
        return;
      }
      // The claim is in a mempool, which proves nothing yet: a late move can
      // still win the input. Record the ending the chain actually accepted.
      const settled = await cov.awaitSettlement(rpc, match, low, 30_000);
      if (settled?.status === "ended")
        finish(
          mode.describeEnd(settled.spend, match, myPk),
          mode.finalSnapshot(settled.spend, match),
        );
      else if (settled?.status === "advanced") updateMatch(settled.match);
    });

  // Cancellation is separate from Home, which always preserves live games.
  const cancelOpenGame = async () => {
    if (open && role === "p1") {
      const ok = await askConfirm({
        title: "Cancel game?",
        body: staked
          ? "Your stake returns to your balance. The invite link will no longer work."
          : "This cancels the game. The invite link will no longer work.",
        confirm: "Cancel game",
        danger: true,
      });
      if (!ok) return;
      runAction(async () => {
        const rpc = await getRpc();
        try {
          await cov.cancelMatch(rpc, seatKey(), match);
        } catch (e) {
          // An open game has no other way out, so a missing UTXO is either a
          // join landing mid-click or a game opened under an older contract
          // build: its address derives from the old bytecode, and retrying
          // from this build can never find it.
          if (/game UTXO not found/.test(String((e as any)?.message ?? e)))
            throw new Error(
              "This game can't be found on the network. It may have been created with an older version of the app, or someone just took the seat.",
              { cause: e },
            );
          throw e;
        }
        exitMatch(true);
      });
    }
  };

  // The lobby exit, by who's leaving what. A private host kicks: the seat
  // clears into a fresh game with a new link. In Quick Match nobody chose
  // the opponent or has a link to share, so both seats just leave, at once.
  const exit = isQuick(match) ? "leave" : role === "p1" ? "kick" : "cancel";
  const dissolveGame = async () => {
    const ok = await askConfirm(
      exit === "leave"
        ? {
            title: "Leave game?",
            body: "The game hasn't started. Leaving ends it for both players.",
            confirm: "Leave game",
            danger: true,
          }
        : exit === "kick"
          ? {
              title: "Kick your opponent?",
              body: staked
                ? "Their stake returns and their link stops working. You get a fresh game with a new invite link to share."
                : "Their link stops working. You'll get a fresh game and a new invite link to share.",
              confirm: "Kick them",
              danger: true,
            }
          : {
              title: "Cancel game?",
              body: staked
                ? "It hasn't started, so it's called off and both stakes return."
                : "The game hasn't started. Cancelling ends it for both players.",
              confirm: "Cancel game",
              danger: true,
            },
    );
    if (!ok) return;
    runAction(async () => {
      startConnecting(
        { kick: "Kicking your opponent", leave: "Leaving the game", cancel: "Cancelling the game" }[
          exit
        ],
        [
          staked ? "Connecting to the Kaspa network" : "Connecting to the game",
          staked ? "Returning both stakes" : "Closing the game",
        ],
      );
      const key = seatKey();
      const rpc = await getRpc();
      advanceConnecting();
      // The covenant gates an invite joiner's exit on one move clock —
      // re-check the age on-chain so a slightly-early click gets minutes,
      // not a sequence-lock rejection.
      if (exitWait > 0) {
        const mins = await cov.moveClockRemaining(rpc, match, {
          kind: "age",
          daa: exitWait,
        });
        if (mins) {
          throw new Error(`You can cancel in about ${mins} minute${mins === 1 ? "" : "s"}.`);
        }
      }
      await ensureFunds(rpc, key, cov.FEE_HEADROOM, { staked: isStaked(match) });
      await cov.dissolveMatch(rpc, key, match);
      exitMatch(true);
      // A kick reads as "clear the seat", not "destroy the match". On-chain
      // it must be a new covenant — a dead link is exactly what keeps the
      // kicked player out — so flow straight into hosting a fresh game with
      // a new link to share.
      if (exit === "kick") await createGame();
    });
  };

  const link = inviteLink(match);
  const shown = view.board.shownState;

  // Where the money went, said in balance terms — only for staked games and
  // only to the players in them. Appended to the verdict rather than baked
  // into the ending sentences (resultTone classifies those by substring).
  // A testnet reset returns nothing, so it gets no money line.
  let potLine: string | undefined;
  const challengeWindow = isCore2(match.simul) ? match.simul.revealTimeout : s.moveTimeout;
  const tone = ending?.tone ?? "neutral";
  if (staked && ending?.settling && iAmPlayer) {
    potLine =
      tone === "win"
        ? `Winnings reach your balance about ${fmtDaaDuration(challengeWindow)} after the win. ${
            HAS_SWEEPER
              ? "If they don't arrive, collect them from Your matches."
              : "If you both leave the game before then, collect them from Your matches."
          }`
        : tone === "loss"
          ? "Your opponent's winnings are being processed."
          : "Your share is being returned. You can reopen this game from Your matches.";
  }
  if (staked && result && iAmPlayer && result !== RESET_RESULT) {
    potLine =
      tone === "win"
        ? `The ${fmtKas(match.value)} KAS pot, minus fees, is in your balance.`
        : tone === "loss"
          ? `The ${fmtKas(match.value)} KAS pot went to your opponent.`
          : /draw|split|returned|back|called off|dissolved/i.test(result)
            ? `Your share of the pot came back to your balance (minus fees).`
            : undefined;
  }

  return (
    // The shell has no empty account header during a game. The board gets
    // the space left by the match header, players, and optional invite panel.
    <div className="flex min-h-[calc(100dvh-2rem)] flex-col">
      <GameHeader
        mode={mode.meta}
        moveTimeout={s.moveTimeout}
        busy={busy}
        ended={!!ending}
        capTime={capLeft}
        staked={staked}
        onHome={() => (ending ? leaveEndedGame() : exitMatch(false))}
      />
      {/* The seats flank the status; on narrow screens the status drops to
       * its own line below them. */}
      <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <PlayerPanel
          pk={s.p1}
          profile={p1Profile}
          color={p1Color}
          isMe={role === "p1"}
          clock={
            rpcReady && !ending && view.seats[0].active && view.seats[0].showClock ? clock : null
          }
          collisionPriority={view.seats[0].collisionPriority}
        />
        <div className="order-3 col-span-2 min-w-0 text-center sm:order-0 sm:col-span-1">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <div role="status" aria-live="polite" className="min-w-0">
              {ending ? (
                <span className="text-lg font-semibold">{ending.title}</span>
              ) : !rpcReady ? (
                <span className="inline-flex items-center gap-2 text-dim">
                  <DiscLoader /> Connecting to the game…
                </span>
              ) : open ? (
                <>
                  <h2 className="text-lg font-semibold">Connect four to win</h2>
                  <p className="mt-0.5 text-sm text-dim">Horizontal, vertical, or diagonal.</p>
                </>
              ) : result ? (
                <span>Game over</span>
              ) : full ? (
                <span>Board full…</span>
              ) : (
                <Status status={view.status} />
              )}
            </div>
          </div>
          {staked && !ending && (
            <div
              className="text-sm text-accent"
              title="Both stakes sit in the pot until the game decides who takes it."
            >
              <span className="text-dim">Pot</span>{" "}
              <b className="font-semibold">{fmtKas(open ? match.value * 2n : match.value)} KAS</b>
              {open && <span className="text-dim"> once your opponent joins</span>}
            </div>
          )}
        </div>
        <PlayerPanel
          pk={s.p2}
          align="end"
          profile={p2Profile}
          color={p2Color}
          isMe={role === "p2"}
          clock={
            rpcReady && !ending && view.seats[1].active && view.seats[1].showClock ? clock : null
          }
          collisionPriority={view.seats[1].collisionPriority}
        />
      </div>

      {ending && !overlayDismissed && (
        <ResultOverlay
          title={ending.title}
          result={ending.message}
          pot={potLine}
          tone={tone}
          busy={busy}
          onPlayAgain={playAgain}
          onExit={leaveEndedGame}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}

      {needManualImport && (
        <div className="card mx-auto mt-3 w-full max-w-175 px-4 py-3.5">
          <h2 className="mb-2 text-base font-semibold text-accent">Game out of sync</h2>
          <p className="text-sm text-dim">
            We couldn't load the latest moves. Paste your opponent's current game link to continue.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              className="input"
              aria-label="Invite link to catch up"
              value={importVal}
              onChange={(e) => setImportVal(e.target.value)}
              placeholder="invite link…"
            />
            <button
              className="btn"
              disabled={!importVal.trim()}
              onClick={() =>
                runAction(async () => {
                  await importMatch(importVal);
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

      {/* The board owns whatever height the bars above and below leave: a
       * size container, so the board sizes itself off the real slack (cqh —
       * invite card, error banner and all) instead of guessing reserves off
       * the viewport. items-start keeps a width-bound (phone) board snug
       * under the status bar rather than adrift in the middle of the slack.
       * h-76 + grow (NOT flex-1): a basis-0 item in a min-height column
       * grows on screen but resolves cqh to 0, so the board would collapse
       * to its floor size — an explicit base height keeps cq resolution
       * live, doubles as the floor (size containment means the board can't
       * push the column taller; from the floor up the page just scrolls),
       * and shrink-0 stops tight viewports from squeezing it below that. */}
      <div className="relative flex h-76 shrink-0 grow items-start justify-center py-3 sm:h-80 [container-type:size]">
        {/* Floating over the board's slack space instead of in the column
         * flow, so dismissing the result dialog never shifts the layout. */}
        {ending && overlayDismissed && (
          <div className="absolute top-1 left-1/2 z-10 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-lg border border-ok bg-panel/80 px-3.5 py-2 text-center backdrop-blur-xs">
            {ending.message}
            {potLine && <span className="block text-sm text-accent">{potLine}</span>}
          </div>
        )}
        <Board
          state={shown}
          interactive={!ending && view.board.interactive}
          winningCells={winningCells(shown.board)}
          onDrop={drop}
          p1Color={p1Color}
          nextDisc={view.board.nextDisc}
          {...(view.board.priorityDisc && { priorityDisc: view.board.priorityDisc })}
          {...(view.board.ghostDisc && { ghostDisc: view.board.ghostDisc })}
          myPick={view.board.myPick}
        />
      </div>

      {open && role === "p1" && !needManualImport && (
        <section
          aria-label="Invite an opponent"
          className="card mx-auto w-full max-w-175 px-4 py-3"
        >
          <div className="mb-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Waiting for an opponent</h2>
              <button
                type="button"
                className="min-h-8 shrink-0 cursor-pointer text-xs text-dim underline hover:text-ink disabled:cursor-default disabled:opacity-50"
                disabled={busy}
                onClick={() => void cancelOpenGame()}
              >
                Cancel game
              </button>
            </div>
            <p className="text-xs text-dim">Share this link to start playing.</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label="Invite link"
              className="input"
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn" onClick={() => void copy(link)}>
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
          {copyError && (
            <p role="status" className="mt-2 text-sm text-red">
              {copyError}
            </p>
          )}
        </section>
      )}

      {/* Always one button tall, even when empty, so a button appearing or
       * going away never resizes the board above. */}
      <div className="flex min-h-10.5 flex-wrap items-center justify-center gap-2.5">
        {ending && overlayDismissed && (
          <button className="btn" disabled={busy} onClick={playAgain}>
            Play again
          </button>
        )}
        {view.canClaimTimeout && (
          <button className="btn" disabled={busy} onClick={claimTimeoutWin}>
            Claim timeout win
          </button>
        )}
        {inLobby && iAmPlayer && (
          <button
            className="btn btn-danger"
            disabled={busy || withdrawGated}
            title={
              exit === "kick"
                ? "Before play starts, you can remove your opponent and get a fresh game with a new invite link."
                : exit === "leave"
                  ? "Before play starts, you can leave. The game ends for both players."
                  : withdrawGated
                    ? "You can cancel once the lobby timer ends."
                    : undefined
            }
            onClick={() => void dissolveGame()}
          >
            {exit === "kick"
              ? "Kick opponent"
              : exit === "leave"
                ? "Leave game"
                : withdrawGated && lobbyClock.text
                  ? `Cancel game in ${lobbyClock.text}`
                  : "Cancel game"}
          </button>
        )}
      </div>
    </div>
  );
};
