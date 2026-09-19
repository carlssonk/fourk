/**
 * Fourk V2, view surface. Like the legacy fourk view, in rounds; two things
 * are new. A readiness lobby precedes the first round (both players sign
 * "ready" before any pick is on the clock), and the pick clock is SHARED: it
 * counts the chain's DAA score up to one cutoff both players see, not each
 * player's own age since the last transition. A pick counts when the chain
 * accepts it, so the copy says so.
 */

import { type State } from "../../lib/game";
import { isOpen as stateIsOpen } from "../../lib/game";
import type { Match } from "../../lib/match";
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

export function isReady(core: SimulCore2, player: 0 | 1): boolean {
  return (core.readyMask & (player + 1)) !== 0;
}

/** The second commit landed after the cutoff: the first committer is owed
 * the pot and no reveal can happen. Known once the two-commit UTXO's
 * acceptance was observed. */
export function lateSecondCommit(m: Match): boolean {
  const core = core2Of(m);
  return (
    core.readyMask === 3 &&
    core.pendingWin === 0 &&
    roundPhase(v2Snapshot(m)) === "reveal" &&
    m.acceptedDaa !== undefined &&
    m.acceptedDaa > core.pickDeadline
  );
}

/** The lone commit on the table landed after the cutoff: nobody picked on
 * time and the round settles as a draw. */
export function lateFirstCommit(m: Match): boolean {
  const core = core2Of(m);
  return (
    core.readyMask === 3 &&
    core.pendingWin === 0 &&
    roundPhase(v2Snapshot(m)) === "commit" &&
    commitCount(core) === 1 &&
    m.acceptedDaa !== undefined &&
    m.acceptedDaa > core.pickDeadline
  );
}

/** The score a one-commit timeout claim must wait for: the cutoff, or the
 * rebase grace after the first commit's acceptance, whichever is later. */
export function claimScore(m: Match): number {
  const core = core2Of(m);
  return m.acceptedDaa === undefined
    ? core.pickDeadline
    : Math.max(core.pickDeadline, m.acceptedDaa + v2.REBASE_GRACE_DAA);
}

function roundStarted(m: Match): boolean {
  return !stateIsOpen(m.state) && core2Of(m).readyMask === 3;
}

/** Joined but not both ready: either player can still dissolve (P2 after
 * one clock), and readiness is what closes the lobby. */
function inLobby(m: Match): boolean {
  return !stateIsOpen(m.state) && core2Of(m).readyMask !== 3;
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
  const obligation =
    f.open || f.full || core.readyMask !== 3 ? null : myObligation(m.state, core, ctx.myPk);
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

function status(m: Match, ctx: ViewCtx, r: RoundView): StatusDescriptor {
  const iAmPlayer = ctx.role !== "spectator";
  const core = core2Of(m);
  const myIdx = ctx.role === "p2" ? 1 : 0;
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
  if (core.readyMask !== 3) {
    if (!iAmPlayer) return { segments: [{ text: "Waiting for both players to ready up…" }] };
    if (!isReady(core, myIdx as 0 | 1))
      return {
        segments: [
          { text: "Ready up to start", bold: true },
          { text: ". Once both players are ready, each round has one shared pick timer." },
        ],
      };
    return { segments: [{ text: "Waiting for your opponent to ready up…" }], spinner: true };
  }
  if (lateSecondCommit(m)) {
    return core.firstCommitter === myIdx + 1
      ? {
          segments: [
            { text: "Your opponent's pick arrived too late", bold: true },
            { text: ". You can claim the win." },
          ],
        }
      : iAmPlayer
        ? {
            segments: [
              { text: "Your pick arrived after the deadline", bold: true },
              { text: ". Your opponent can claim the win." },
            ],
            tone: "danger",
          }
        : { segments: [{ text: "A pick arrived after the deadline." }], tone: "dim" };
  }
  if (lateFirstCommit(m))
    return {
      segments: [
        { text: "The first pick arrived after the deadline", bold: true },
        { text: ". The round is settled as a draw." },
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
  if (r.obligation === "commit" && ctx.clockExpired)
    return commitCount(core) === 0
      ? {
          segments: [
            { text: "Time is up", bold: true },
            { text: ". Neither player picked, so the round is settled as a draw." },
          ],
          tone: "danger",
        }
      : {
          segments: [
            { text: "Your time is up", bold: true },
            { text: ". Your opponent can claim the win." },
          ],
          tone: "danger",
        };
  if (r.obligation === "commit")
    return {
      segments: [
        { text: "Pick a column", bold: true },
        {
          text: ". Both players pick in secret before the shared timer ends. A pick counts once the network confirms it.",
        },
      ],
    };
  if (r.obligation !== null)
    return { segments: [{ text: "Revealing your pick…" }], tone: "dim", spinner: true };
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
   * from that output). One commit: the absolute cutoff — plus the rebase
   * grace, once the first commit's acceptance is known, because that is
   * the score the timeout claim must wait for. Both commits, or a reveal on
   * the table: the reveal grace as UTXO age.
   */
  clock(m: Match): ClockSpec | null {
    if (stateIsOpen(m.state)) return null;
    const core = core2Of(m);
    if (core.readyMask !== 3 || core.pendingWin !== 0) return null;
    if (roundPhase(v2Snapshot(m)) !== "commit") return { kind: "age", daa: core.revealTimeout };
    const count = commitCount(core);
    if (count === 0) return { kind: "age", daa: m.state.moveTimeout };
    if (lateFirstCommit(m)) return null;
    return { kind: "absolute", daa: claimScore(m) };
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
    const showPriority = playing && started && !full && !pending;
    const decided = lateSecondCommit(m) || lateFirstCommit(m);
    const live = playing && started && !full && !pending && !decided;
    return {
      status: status(m, ctx, r),
      seats: [
        {
          active: live && !r.acted[0],
          showClock: live && !r.acted[0],
          collisionPriority: showPriority && priority === 0,
        },
        {
          active: live && !r.acted[1],
          showClock: live && !r.acted[1],
          collisionPriority: showPriority && priority === 1,
        },
      ],
      board: {
        shownState,
        interactive:
          r.obligation === "commit" &&
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
        claimTimeoutGate(f, ctx, {
          started,
          notOwed: !pending && r.obligation === null && !r.acted[(1 - myIdx) as 0 | 1],
        }) ||
        (playing && lateSecondCommit(m) && core.firstCommitter === myIdx + 1),
      canReady:
        playing && ctx.role !== "spectator" && core.readyMask !== 3 && !isReady(core, myIdx),
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
      case "split_timeout":
        return commitCount(core) === 0 && core.readyMask === 3
          ? "Neither player picked before the timer ended. The pot split evenly."
          : "The game stalled on both sides. It timed out and the pot split evenly.";
      default:
        return GENERIC_END;
    }
  },

  finalSnapshot(_spend: SpendInfo | null, m: Match): Match {
    return m;
  },
} satisfies ModeViewSurface;
