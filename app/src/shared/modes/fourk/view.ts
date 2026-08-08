/**
 * Fourk mode, view surface. Rounds instead of turns: both seats can be
 * active at once, the status speaks in picks and reveals, and the board
 * holds the sealed pick as a ghost instead of advancing optimistically (the
 * opponent's column is unknown until the round resolves). Strings verbatim
 * from the pre-refactor UI.
 */

import { CELLS, type State } from "../../lib/game";
import { isOpen as stateIsOpen } from "../../lib/game";
import type { Match } from "../../lib/match";
import type { SpendInfo } from "../../lib/engine";
import type { ModeView, ModeViewSurface, StatusDescriptor, ViewCtx } from "../types";
import { GENERIC_END, describeSharedEnd } from "../common";
import {
  ZERO_HASH,
  coreOf,
  myObligation,
  priorityPlayer,
  roundPhase,
  type Obligation,
} from "./core";
import { simulSnapshot } from "./engine";
import { loadSalt } from "./saltStore";

interface RoundView {
  phase: ReturnType<typeof roundPhase>;
  obligation: Obligation | null;
  /** Per seat: has it met its current obligation? */
  acted: [boolean, boolean];
  myPick: number | null;
  saltMissing: boolean;
}

function roundView(m: Match, ctx: ViewCtx): RoundView {
  const core = coreOf(m);
  const phase = roundPhase(simulSnapshot(m));
  const open = stateIsOpen(m.state);
  const full = m.state.moveCount >= CELLS;
  const obligation = open || full ? null : myObligation(m.state, core, ctx.myPk);
  // "Acted" per seat: in the commit phase a set slot; once reveals start,
  // the revealer has acted and the resolver hasn't.
  const acted: [boolean, boolean] =
    phase === "commit"
      ? [core.commit1 !== ZERO_HASH, core.commit2 !== ZERO_HASH]
      : phase === "reveal"
        ? [false, false]
        : [core.reveal1 !== 0, core.reveal2 !== 0];
  const rec = ctx.role !== "spectator" ? loadSalt(m.covenantId, core.round) : null;
  const committed =
    ctx.role === "p1"
      ? core.commit1 !== ZERO_HASH || core.reveal1 !== 0
      : ctx.role === "p2"
        ? core.commit2 !== ZERO_HASH || core.reveal2 !== 0
        : false;
  return {
    phase,
    obligation,
    acted,
    myPick: committed && rec ? rec.col : null,
    saltMissing: (obligation === "reveal" || obligation === "resolve") && !rec,
  };
}

function status(m: Match, ctx: ViewCtx, r: RoundView, inLobbyNow: boolean): StatusDescriptor {
  const iAmPlayer = ctx.role !== "spectator";
  // The challenge window: a win is claimed and the pot is parked for one
  // move clock. The client handles everything (the contest if a second line
  // exists, the sweep when the window lapses) — the status just says so.
  const pending = coreOf(m).pendingWin;
  if (pending !== 0) {
    const myDisc = ctx.role === "p2" ? 2 : 1;
    if (!iAmPlayer)
      return { segments: [{ text: "A win was claimed — the pot pays out shortly…" }], tone: "dim" };
    return pending === myDisc
      ? {
          segments: [
            { text: "You connected four!", bold: true },
            { text: " The pot pays out shortly…" },
          ],
          spinner: true,
        }
      : {
          segments: [
            { text: "Your opponent connected four", bold: true },
            { text: " — verifying the board before the pot pays out…" },
          ],
          tone: "dim",
          spinner: true,
        };
  }
  if (r.saltMissing)
    return {
      segments: [
        { text: "Your sealed pick lives in another browser", bold: true },
        {
          text: " — it can't be revealed here. If the clock runs out, your opponent can claim the pot.",
        },
      ],
      tone: "danger",
    };
  if (ctx.pendingCol !== null && r.obligation === "commit")
    return { segments: [{ text: "Sealing your pick…" }], tone: "dim", spinner: true };
  if (r.obligation === "commit" && ctx.clockExpired && roundStarted(m))
    return {
      segments: [
        { text: "Your time is up", bold: true },
        { text: " — your opponent can claim the pot. Pick now!" },
      ],
      tone: "danger",
    };
  if (r.obligation === "commit")
    return inLobbyNow
      ? {
          segments: [
            { text: "Your opponent joined", bold: true },
            { text: " — pick a column in secret" },
          ],
        }
      : {
          segments: [
            { text: "Pick a column", bold: true },
            { text: " — your opponent won't see it until both have picked" },
          ],
        };
  if (r.obligation !== null)
    return { segments: [{ text: "Revealing your pick…" }], tone: "dim", spinner: true };
  if (iAmPlayer && r.phase === "commit")
    return { segments: [{ text: "You picked — waiting for your opponent's secret pick…" }] };
  if (iAmPlayer)
    return { segments: [{ text: "You revealed — waiting for your opponent's disc to drop…" }] };
  return { segments: [{ text: "Both players are picking columns in secret…" }] };
}

function roundStarted(m: Match): boolean {
  const core = coreOf(m);
  return (
    m.state.moveCount > 0 ||
    roundPhase(simulSnapshot(m)) !== "commit" ||
    core.commit1 !== ZERO_HASH ||
    core.commit2 !== ZERO_HASH
  );
}

/** Joined but nothing staked yet: the first COMMITMENT (not disc) closes
 * the lobby — a lone commitment is a one-sided obligation the timeout
 * doors handle. */
function inLobby(m: Match): boolean {
  if (stateIsOpen(m.state)) return false;
  const core = coreOf(m);
  return (
    core.round === 0 &&
    roundPhase(simulSnapshot(m)) === "commit" &&
    core.commit1 === ZERO_HASH &&
    core.commit2 === ZERO_HASH
  );
}

export const fourkView = {
  roundStarted,
  inLobby,

  view(m: Match, ctx: ViewCtx): ModeView {
    const s = m.state;
    const open = stateIsOpen(s);
    const full = s.moveCount >= CELLS;
    const playing = !open && !ctx.result;
    const pending = coreOf(m).pendingWin !== 0;
    const r = roundView(m, ctx);
    const myIdx = ctx.role === "p2" ? 1 : 0;
    const shownState: State = s;
    // Whose disc lands underneath if both pick the same column this round —
    // a plannable resource, so both seats always see whose "round" it is.
    const priority = priorityPlayer(coreOf(m).round);
    const showPriority = playing && !full && !pending;
    return {
      status: status(m, ctx, r, inLobby(m)),
      seats: [
        {
          active: playing && !full && !pending && !r.acted[0],
          showClock: roundStarted(m) && !pending && !r.acted[0],
          collisionPriority: showPriority && priority === 0,
        },
        {
          active: playing && !full && !pending && !r.acted[1],
          showClock: roundStarted(m) && !pending && !r.acted[1],
          collisionPriority: showPriority && priority === 1,
        },
      ],
      board: {
        shownState,
        interactive:
          r.obligation === "commit" && !ctx.busy && ctx.pendingCol === null && !ctx.result,
        nextDisc: playing && !full && !pending ? "both" : null,
        priorityDisc: (priority + 1) as 1 | 2,
        ...(ctx.role !== "spectator" && { ghostDisc: (myIdx + 1) as 1 | 2 }),
        myPick: playing ? (r.myPick ?? ctx.pendingCol) : null,
      },
      canClaimTimeout:
        !open &&
        !full &&
        !pending &&
        r.obligation === null &&
        ctx.role !== "spectator" &&
        !ctx.result &&
        roundStarted(m) &&
        ctx.clockExpired &&
        !r.acted[(1 - myIdx) as 0 | 1],
    };
  },

  describeEnd(spend: SpendInfo | null, m: Match, myPk: string): string {
    const shared = describeSharedEnd(spend, m, myPk);
    if (shared) return shared;
    const s = m.state;
    switch (spend?.kind) {
      case "sweep_win": {
        // Only reachable from a pending state, whose pendingWin names the
        // winner (claim_win itself is a continuation now — the challenge
        // window — and never reaches ending classification).
        const winner = coreOf(m).pendingWin === 1 ? s.p1 : coreOf(m).pendingWin === 2 ? s.p2 : null;
        if (!winner) return GENERIC_END;
        return winner === myPk
          ? "You connected four — you win! 🎉"
          : "Your opponent connected four — they win this one.";
      }
      case "claim_split":
        return "You both connected four in the same drop — the pot split evenly.";
      case "claim_timeout": {
        // The compliant claimant, from the pre-spend state: the lone
        // revealer, else the lone committer.
        const core = coreOf(m);
        const claimant =
          core.reveal1 !== 0
            ? s.p1
            : core.reveal2 !== 0
              ? s.p2
              : core.commit1 !== ZERO_HASH
                ? s.p1
                : s.p2;
        return claimant === myPk
          ? "Your opponent ran out of time — you win by timeout. 🎉"
          : "The round timer ran out and your opponent claimed the pot.";
      }
      case "split_timeout":
        return "The game stalled on both sides — it timed out and the pot split evenly.";
      default:
        return GENERIC_END;
    }
  },

  /** Fourk boards are already final — resolution landed every disc. */
  finalSnapshot(_spend: SpendInfo | null, m: Match): Match {
    return m;
  },
} satisfies ModeViewSurface;
