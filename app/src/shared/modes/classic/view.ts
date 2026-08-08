/**
 * Classic mode, view surface. Alternating turns: one seat is active, the
 * status speaks in "your turn", and the optimistic board replays the pending
 * column locally. All user-facing strings are verbatim from the pre-mode UI.
 */

import { applyMove, discOf, playerToMove, type State } from "../../lib/game";
import { isOpen as stateIsOpen } from "../../lib/game";
import type { Match } from "../../lib/match";
import type { SpendInfo } from "../../lib/engine";
import type { ModeView, ModeViewSurface, StatusDescriptor, ViewCtx } from "../types";
import { GENERIC_END, claimTimeoutGate, describeSharedEnd, viewFlags } from "../common";

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

function status(m: Match, ctx: ViewCtx, myTurn: boolean, mover: 0 | 1): StatusDescriptor {
  const s = m.state;
  const iAmPlayer = ctx.role !== "spectator";
  if (ctx.pendingCol !== null)
    // The optimistic disc is already on the board — saying "your turn" now
    // would invite a second click that can't go through.
    return { segments: [{ text: "Confirming your move…" }], tone: "dim", spinner: true };
  if (myTurn && ctx.clockExpired)
    return {
      segments: [
        { text: "Your time is up", bold: true },
        { text: " — your opponent can claim the win. Move now!" },
      ],
      tone: "danger",
    };
  if (myTurn)
    return s.moveCount === 0
      ? {
          segments: [
            { text: "Your opponent joined", bold: true },
            { text: " — drop a disc to start" },
          ],
        }
      : { segments: [{ text: "Your turn", bold: true }, { text: " — drop a disc" }] };
  if (iAmPlayer && s.moveCount === 0)
    return { segments: [{ text: "Waiting for your opponent to start…" }] };
  if (iAmPlayer) return { segments: [{ text: "Opponent's turn…" }] };
  const p1Color = m.p1Color ?? "red";
  const moverColor = mover === 0 ? p1Color : p1Color === "red" ? "blue" : "red";
  return { segments: [{ text: `${moverColor === "red" ? "Red" : "Blue"} to move` }] };
}

export const classicView = {
  roundStarted(m: Match): boolean {
    return m.state.moveCount > 0;
  },

  inLobby(m: Match): boolean {
    return !stateIsOpen(m.state) && m.state.moveCount === 0;
  },

  view(m: Match, ctx: ViewCtx): ModeView {
    const s = m.state;
    const f = viewFlags(m, ctx);
    const { open, full, playing } = f;
    const mover = playerToMove(s);
    const myPkSeat = mover === 0 ? s.p1 : s.p2;
    const myTurn = !open && !full && myPkSeat === ctx.myPk && !ctx.result;
    const shownState: State =
      ctx.pendingCol !== null && !open && !full ? applyMove(s, ctx.pendingCol) : s;
    return {
      status: status(m, ctx, myTurn, mover),
      seats: [
        { active: playing && !full && mover === 0, showClock: mover === 0 },
        { active: playing && !full && mover === 1, showClock: mover === 1 },
      ],
      board: {
        shownState,
        interactive: myTurn && !ctx.busy && ctx.pendingCol === null,
        nextDisc: playing && !full ? (discOf(playerToMove(shownState)) as 1 | 2) : null,
        myPick: null,
      },
      canClaimTimeout: claimTimeoutGate(f, ctx, {
        started: s.moveCount > 0,
        notOwed: !myTurn,
      }),
    };
  },

  describeEnd(spend: SpendInfo | null, m: Match, myPk: string): string {
    const shared = describeSharedEnd(spend, m, myPk);
    if (shared) return shared;
    const s = m.state;
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
      default:
        return GENERIC_END;
    }
  },

  /** A discovered winning move pinpoints the final disc — end on the
   * finished board (which also lights up the winning line), not the position
   * one move earlier. The record's txid advances with it: describeEnd's
   * attribution relies on state matching txid, so a half-updated record
   * would misread the ending on a later reopen. */
  finalSnapshot(spend: SpendInfo | null, m: Match): Match {
    if (spend?.kind === "winning_move" && spend.args.length && isHex64(spend.txid)) {
      try {
        return { ...m, state: applyMove(m.state, spend.args[0]!), txid: spend.txid };
      } catch {
        /* stale local state — keep the board we have */
      }
    }
    return m;
  },
} satisfies ModeViewSurface;
