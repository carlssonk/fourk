/**
 * Fourk V2, view surface. Like the legacy fourk view, in rounds, with one
 * thing new: the pick clock is SHARED. It counts the chain's DAA score up to
 * one cutoff both players see, not each player's own age since the last
 * transition. A pick counts when the chain accepts it, so the copy says so.
 *
 * The first round has no shared cutoff before its first pick: the joined
 * lobby is where both players pick, and whichever pick lands first starts
 * the other player's window. That round never forfeits anyone — a missing
 * or late second pick calls the game off and refunds both — so its copy
 * says "called off" where a later round says "claim the win".
 */

import { type State } from "../../lib/game";
import { isOpen as stateIsOpen } from "../../lib/game";
import { isStaked, type Match } from "../../lib/match";
import type { SpendInfo } from "../../lib/engine";
import type { ClockSpec, ModeView, ModeViewSurface, StatusDescriptor, ViewCtx } from "../types";
import {
  GENERIC_END,
  SUDDEN_DEATH_MESSAGE,
  claimTimeoutGate,
  describeSharedEnd,
  viewFlags,
  type ViewFlags,
} from "../common";
import {
  ZERO_HASH,
  myObligation,
  priorityPlayer,
  roundPhase,
  type Obligation,
} from "../fourk/core";
import { loadSalt } from "../fourk/saltStore";
import { commitCount, core2Of, v2, type SimulCore2 } from "./core";
import { v2Snapshot } from "./engine";

/** Whether a missing pick can be forfeited here: from the second round on,
 * or once a reveal is on the table (a proven obligation in any round). */
export function forfeitable(core: SimulCore2): boolean {
  return core.round > 0 || core.reveal1 !== 0 || core.reveal2 !== 0;
}

/** The second commit landed after the cutoff: no reveal can happen. From
 * the second round on the first committer is owed the pot; in the first
 * round the game is called off. Known once the two-commit UTXO's acceptance
 * was observed. */
export function lateSecondCommit(m: Match): boolean {
  const core = core2Of(m);
  return (
    core.pendingWin === 0 &&
    roundPhase(v2Snapshot(m)) === "reveal" &&
    m.acceptedDaa !== undefined &&
    m.acceptedDaa > core.pickDeadline
  );
}

/** The lone commit on the table landed after the cutoff: nobody picked on
 * time and the round settles as a draw. (Never in the first round, whose
 * lone pick has no cutoff to be late for.) */
export function lateFirstCommit(m: Match): boolean {
  const core = core2Of(m);
  return (
    core.round > 0 &&
    core.pendingWin === 0 &&
    roundPhase(v2Snapshot(m)) === "commit" &&
    commitCount(core) === 1 &&
    m.acceptedDaa !== undefined &&
    m.acceptedDaa > core.pickDeadline
  );
}

/** The score a lone pick's settlement waits for. From the second round on:
 * the cutoff, or the rebase grace after the first commit's acceptance,
 * whichever is later (the first committer's claim). In the first round:
 * the picking window after the lone pick (the refund) — null until that
 * pick's acceptance is known. */
export function lonePickScore(m: Match): number | null {
  const core = core2Of(m);
  if (core.round === 0)
    return m.acceptedDaa === undefined ? null : m.acceptedDaa + m.state.moveTimeout;
  return m.acceptedDaa === undefined
    ? core.pickDeadline
    : Math.max(core.pickDeadline, m.acceptedDaa + v2.REBASE_GRACE_DAA);
}

function roundStarted(m: Match): boolean {
  const core = core2Of(m);
  return (
    m.state.moveCount > 0 ||
    roundPhase(v2Snapshot(m)) !== "commit" ||
    core.commit1 !== ZERO_HASH ||
    core.commit2 !== ZERO_HASH
  );
}

/** Joined but nothing picked yet: the first COMMITMENT closes the lobby —
 * it starts the other player's window, and a lone first-round pick nobody
 * answers is refunded through the split door, not the lobby exits. */
function inLobby(m: Match): boolean {
  if (stateIsOpen(m.state)) return false;
  const core = core2Of(m);
  return (
    core.round === 0 &&
    roundPhase(v2Snapshot(m)) === "commit" &&
    core.commit1 === ZERO_HASH &&
    core.commit2 === ZERO_HASH
  );
}

interface RoundView {
  phase: ReturnType<typeof roundPhase>;
  obligation: Obligation | null;
  acted: [boolean, boolean];
  myPick: number | null;
  saltMissing: boolean;
}

function roundView(m: Match, ctx: ViewCtx, f: ViewFlags): RoundView {
  const core = core2Of(m);
  const phase = roundPhase(v2Snapshot(m));
  const obligation = f.open || f.full ? null : myObligation(m.state, core, ctx.myPk);
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

/** The first round's refund, said without money in a free game. */
const calledOff = (m: Match) =>
  isStaked(m) ? ". The game is called off and both stakes return." : ". The game is called off.";

function status(m: Match, ctx: ViewCtx, r: RoundView): StatusDescriptor {
  const iAmPlayer = ctx.role !== "spectator";
  const core = core2Of(m);
  const myIdx = ctx.role === "p2" ? 1 : 0;
  const firstRound = core.round === 0;
  if (core.pendingWin !== 0) {
    const myDisc = ctx.role === "p2" ? 2 : 1;
    const window = " Checking the final board…";
    if (!iAmPlayer)
      return { segments: [{ text: "A win was claimed." }, { text: window }], tone: "dim" };
    return core.pendingWin === myDisc
      ? {
          segments: [{ text: "You connected four!", bold: true }, { text: window }],
          spinner: true,
        }
      : {
          segments: [{ text: "Your opponent connected four.", bold: true }, { text: window }],
          tone: "dim",
          spinner: true,
        };
  }
  if (lateSecondCommit(m)) {
    if (!iAmPlayer)
      return { segments: [{ text: "A pick arrived after the deadline." }], tone: "dim" };
    const mine = core.firstCommitter !== myIdx + 1;
    if (firstRound)
      return {
        segments: [
          {
            text: mine
              ? "Your pick arrived after the deadline"
              : "Your opponent's pick arrived too late",
            bold: true,
          },
          { text: calledOff(m) },
        ],
        tone: "dim",
      };
    return mine
      ? {
          segments: [
            { text: "Your pick arrived after the deadline", bold: true },
            { text: ". Your opponent can claim the win." },
          ],
          tone: "danger",
        }
      : {
          segments: [
            { text: "Your opponent's pick arrived too late", bold: true },
            { text: ". You can claim the win." },
          ],
        };
  }
  if (lateFirstCommit(m))
    return {
      segments: [
        { text: "The first pick arrived after the deadline", bold: true },
        { text: ". The game ends in a draw." },
      ],
      tone: "dim",
    };
  if (r.saltMissing)
    return {
      segments: [
        { text: "Your pick was saved in another browser", bold: true },
        {
          text: ". It can't be revealed here. If the clock runs out, your opponent can claim the win.",
        },
      ],
      tone: "danger",
    };
  if (ctx.pendingCol !== null && r.obligation === "commit")
    return { segments: [{ text: "Sealing your pick…" }], tone: "dim", spinner: true };
  if (r.obligation === "commit" && ctx.clockExpired) {
    if (commitCount(core) === 0)
      return {
        segments: [
          { text: "Time is up", bold: true },
          { text: ". Neither player picked, so the game ends in a draw." },
        ],
        tone: "danger",
      };
    return firstRound
      ? {
          segments: [{ text: "Your time is up", bold: true }, { text: calledOff(m) }],
          tone: "danger",
        }
      : {
          segments: [
            { text: "Your time is up", bold: true },
            { text: ". Your opponent can claim the win." },
          ],
          tone: "danger",
        };
  }
  // The rules live in How to play; the status only says what to do. The
  // one exception is the opening pick, where "hidden" isn't obvious yet.
  if (r.obligation === "commit")
    return firstRound && commitCount(core) === 0
      ? {
          segments: [
            { text: "Pick a column", bold: true },
            { text: ". Your pick stays hidden until both players have picked." },
          ],
        }
      : { segments: [{ text: "Pick a column", bold: true }] };
  if (r.obligation !== null)
    return { segments: [{ text: "Revealing your pick…" }], tone: "dim", spinner: true };
  if (iAmPlayer && r.phase === "commit" && firstRound && ctx.clockExpired)
    return {
      segments: [{ text: "Your opponent didn't pick in time", bold: true }, { text: calledOff(m) }],
      tone: "dim",
    };
  if (iAmPlayer && r.phase === "commit")
    return { segments: [{ text: "Pick saved. Waiting for your opponent…" }] };
  if (iAmPlayer) return { segments: [{ text: "Waiting for your opponent to reveal…" }] };
  return { segments: [{ text: "Both players are picking columns in secret…" }] };
}

/** The whole-game cap's payout for a pre-spend state: the timeout owner
 * (or pending winner) it preserves, else 0 for the even split. */
export function capOwner(m: Match): number {
  const core = core2Of(m);
  if (core.pendingWin !== 0) return core.pendingWin;
  if (core.reveal1 !== 0) return 1;
  if (core.reveal2 !== 0) return 2;
  if (core.round === 0) return 0;
  const count = commitCount(core);
  if (count === 0 || m.acceptedDaa === undefined) return 0;
  const late = m.acceptedDaa > core.pickDeadline;
  return (count === 1) !== late ? core.firstCommitter : 0;
}

export const fourk2View = {
  roundStarted,
  inLobby,

  /**
   * The obligation clock. No commits yet: the round-start UTXO's age up to
   * the picking window (the same number both players see, since both count
   * from that output) — none in the joined lobby, which has no forfeit
   * clock by contract. One commit: the absolute score its settlement waits
   * for (see lonePickScore). Both commits, or a reveal on the table: the
   * reveal grace as UTXO age.
   */
  clock(m: Match): ClockSpec | null {
    if (stateIsOpen(m.state)) return null;
    const core = core2Of(m);
    if (core.pendingWin !== 0) return null;
    if (roundPhase(v2Snapshot(m)) !== "commit") return { kind: "age", daa: core.revealTimeout };
    const count = commitCount(core);
    if (count === 0) return core.round === 0 ? null : { kind: "age", daa: m.state.moveTimeout };
    if (lateFirstCommit(m)) return null;
    const score = lonePickScore(m);
    return score === null ? null : { kind: "absolute", daa: score };
  },

  view(m: Match, ctx: ViewCtx): ModeView {
    const s = m.state;
    const f = viewFlags(m, ctx);
    const { full, playing } = f;
    const core = core2Of(m);
    const pending = core.pendingWin !== 0;
    const started = roundStarted(m);
    const r = roundView(m, ctx, f);
    const myIdx = (ctx.role === "p2" ? 1 : 0) as 0 | 1;
    const shownState: State = s;
    const priority = priorityPlayer(core.round);
    const showPriority = playing && !full && !pending;
    const decided = lateSecondCommit(m) || lateFirstCommit(m);
    const live = playing && !full && !pending && !decided;
    return {
      status: status(m, ctx, r),
      seats: [
        {
          active: live && !r.acted[0],
          showClock: live && started && !r.acted[0],
          collisionPriority: showPriority && priority === 0,
        },
        {
          active: live && !r.acted[1],
          showClock: live && started && !r.acted[1],
          collisionPriority: showPriority && priority === 1,
        },
      ],
      board: {
        shownState,
        // Past your own cutoff a pick can no longer count (a late second pick
        // just hands the round over); the status says so instead.
        interactive:
          r.obligation === "commit" &&
          !(ctx.clockExpired && started) &&
          !ctx.busy &&
          ctx.pendingCol === null &&
          !ctx.result &&
          !decided,
        nextDisc: live ? "both" : null,
        priorityDisc: (priority + 1) as 1 | 2,
        ...(ctx.role !== "spectator" && { ghostDisc: (myIdx + 1) as 1 | 2 }),
        myPick: playing ? (r.myPick ?? ctx.pendingCol) : null,
      },
      canClaimTimeout:
        forfeitable(core) &&
        (claimTimeoutGate(f, ctx, {
          started,
          notOwed: !pending && r.obligation === null && !r.acted[(1 - myIdx) as 0 | 1],
        }) ||
          (playing && lateSecondCommit(m) && core.firstCommitter === myIdx + 1)),
    };
  },

  describeEnd(spend: SpendInfo | null, m: Match, myPk: string): string {
    const s = m.state;
    const core = core2Of(m);
    if (spend?.kind === "sudden_death") {
      const owner = capOwner(m);
      if (owner === 0) return SUDDEN_DEATH_MESSAGE;
      const winner = owner === 1 ? s.p1 : s.p2;
      return winner === myPk
        ? "Time's up. The game hit its total time limit and you took the pot."
        : "Time's up. The game hit its total time limit and your opponent took the pot.";
    }
    const shared = describeSharedEnd(spend, m, myPk);
    if (shared) return shared;
    switch (spend?.kind) {
      case "sweep_win": {
        const winner = core.pendingWin === 1 ? s.p1 : core.pendingWin === 2 ? s.p2 : null;
        if (!winner) return GENERIC_END;
        return winner === myPk ? "You connected four. You win!" : "Your opponent connected four.";
      }
      case "claim_split":
        return "You both connected four in the same drop. The pot split evenly.";
      case "claim_timeout": {
        // The compliant claimant: the lone revealer, else whoever committed
        // first (a late or missing second pick loses).
        const claimant =
          core.reveal1 !== 0
            ? s.p1
            : core.reveal2 !== 0
              ? s.p2
              : core.firstCommitter === 1
                ? s.p1
                : s.p2;
        return claimant === myPk
          ? "Your opponent ran out of time. You win by timeout."
          : "The pick timer ran out and your opponent claimed the pot.";
      }
      case "split_timeout": {
        const count = commitCount(core);
        if (core.round === 0 && count === 1) return FIRST_ROUND_STALL_MESSAGE;
        if (core.round === 0 && count === 2 && lateSecondCommit(m)) return FIRST_ROUND_LATE_MESSAGE;
        return count === 0 && core.round > 0
          ? "Neither player picked before the timer ended. The pot split evenly."
          : "The game stalled on both sides. It timed out and the pot split evenly.";
      }
      default:
        return GENERIC_END;
    }
  },

  finalSnapshot(_spend: SpendInfo | null, m: Match): Match {
    return m;
  },
} satisfies ModeViewSurface;

export const FIRST_ROUND_STALL_MESSAGE =
  "The second pick never landed. The game was called off and the pot split evenly.";
export const FIRST_ROUND_LATE_MESSAGE =
  "The second pick arrived after the deadline. The game was called off and the pot split evenly.";
