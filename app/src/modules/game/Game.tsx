import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import * as cov from "@shared/lib/covenant";
import { ensureFunds } from "@shared/lib/dispenser";
import { applyMove, discOf, findWin, playerToMove } from "@shared/lib/game";
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
import { Board, PlayerPanel } from "./components";
import { useCapClock } from "./hooks/useCapClock";
import { useMatchWatcher } from "./hooks/useMatchWatcher";
import { useMoveClock } from "./hooks/useMoveClock";
import { matchView, winningCells } from "./lib";

interface Props {
  match: Match;
}

export const Game = ({ match }: Props) => {
  const busy = useAtomValue(busyAtom);
  const rpcReady = useAtomValue(rpcClientAtom) !== null;
  const [importVal, setImportVal] = useState("");
  const [copied, setCopied] = useState(false);

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
  const p1Profile =
    match.profiles?.p1 ?? (role === "p1" && myProfile.name ? myProfile : undefined);
  const p2Profile =
    match.profiles?.p2 ?? (role === "p2" && myProfile.name ? myProfile : undefined);
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

  const drop = (col: number) =>
    runAction(async () => {
      const { key } = getWallet();
      const rpc = await getRpc();
      const next = applyMove(s, col);
      const witness = findWin(next.board, discOf(playerToMove(s)));
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
    });

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
    <div className="mx-auto max-w-175">
      <div className="mb-3 flex flex-wrap gap-6">
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
          <span
            className="text-sm text-dim"
            title="This game has a total time limit. If it's still unfinished when the limit hits, the pot splits evenly and both stakes return."
          >
            ⌛ pot splits in {capLeft} if unfinished
          </span>
        )}
      </div>

      {result && (
        <div className="mb-4 rounded-lg border border-ok bg-ok/10 px-3.5 py-2.5">
          {result}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-center gap-3">
        <PlayerPanel
          pk={s.p1}
          profile={p1Profile}
          color={p1Color}
          isMe={role === "p1"}
          active={playing && !full && mover === 0}
          clock={mover === 0 ? clock.text : null}
        />
        <Board
          state={s}
          interactive={myTurn && !busy}
          winningCells={winningCells(s.board)}
          onDrop={drop}
          p1Color={p1Color}
        />
        <PlayerPanel
          pk={s.p2}
          profile={p2Profile}
          color={p2Color}
          isMe={role === "p2"}
          active={playing && !full && mover === 1}
          clock={mover === 1 ? clock.text : null}
        />
      </div>

      {open && role === "p1" && !needManualImport && (
        <div className="card mb-3 px-4 py-3">
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

      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        {result && (
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
        {result && (
          <button className="btn btn-danger" onClick={() => exitMatch(true)}>
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
          <button className="btn btn-danger" disabled={busy} onClick={leaveMatch}>
            Leave match
          </button>
        )}
      </div>

      {needManualImport && (
        <div className="card mb-4 px-4 py-3.5">
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
        </div>
      )}
    </div>
  );
};
