/** Versioned shared-deadline Fourk rulebook. Legacy matches keep src/simul. */
import * as legacy from "../simul/rules.js";
import {
  isSimulOpen,
  newSimulMatch,
  type SimulState,
  ZERO_HASH,
  isBoardFull,
  validateReachableSimulState,
} from "../simul/state.js";
import { DEADLINE_LIMIT, MIN_MOVE_TIMEOUT_DAA, ZERO_PK, type PubKey } from "../state.js";
import type { Ctx as LegacyCtx, Payout, LineWitness } from "../rules.js";

/** Second-commit rebase grace in DAA (~10 s): commits serialize on one UTXO,
 * so a first commit accepted late in the window forces the opponent's commit
 * to be rebuilt on its output. The second cutoff is the later of the shared
 * deadline and the first commit's acceptance plus this grace, and the first
 * committer's timeout claim waits for that same score. */
export const REBASE_GRACE_DAA = 100;

export interface State extends SimulState {
  /** The shared picking cutoff while a commit is on the table. Zero under a
   * lone first-round commit (see commit): that round has no round-start
   * output before the first pick. */
  pickDeadline: number;
  firstCommitter: number;
  revealTimeout: number;
  /** 1 = paired by Quick Match, 0 = an invite. Set at open, carried
   * unchanged; it only lifts the joiner's lobby wait in dissolve. */
  quick: number;
}

export interface Ctx extends LegacyCtx {
  // Inherited txTime represents a minimum transaction lock time, not "now".
  /** Consensus input acceptance score, never a caller-declared timestamp. */
  inputDaa: number;
}

function req(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function accepted(ctx: Ctx): number {
  req(
    Number.isInteger(ctx.inputDaa) && ctx.inputDaa >= 0 && ctx.inputDaa < DEADLINE_LIMIT,
    "input is not accepted",
  );
  return ctx.inputDaa;
}

function timely(s: State, ctx: Ctx) {
  req(accepted(ctx) <= s.pickDeadline, "pick arrived late");
}

export function newMatch(
  p1: PubKey,
  stake: bigint,
  moveTimeout: number,
  deadline: number,
  revealTimeout: number,
  quick: 0 | 1 = 0,
): State {
  req(
    Number.isInteger(revealTimeout) &&
      revealTimeout >= MIN_MOVE_TIMEOUT_DAA &&
      revealTimeout <= moveTimeout,
    "invalid reveal timeout",
  );
  req(quick === 0 || quick === 1, "invalid quick flag");
  return {
    ...newSimulMatch(p1, stake, moveTimeout, deadline),
    pickDeadline: 0,
    firstCommitter: 0,
    revealTimeout,
    quick,
  };
}

export function join(s: State, ctx: Ctx): State {
  req(
    Number.isInteger(s.revealTimeout) &&
      s.revealTimeout >= MIN_MOVE_TIMEOUT_DAA &&
      s.revealTimeout <= s.moveTimeout,
    "invalid reveal timeout",
  );
  req(s.quick === 0 || s.quick === 1, "invalid quick flag");
  req(s.pickDeadline === 0 && s.firstCommitter === 0, "invalid lobby state");
  return { ...s, ...legacy.join(s, ctx) };
}

export const cancel = legacy.cancel;

/** The lobby exits (host now, joiner after one clock, or at once in Quick
 * Match) close at the first pick: a lone first-round commit is refunded
 * through splitTimeout instead. */
export function dissolve(s: State, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  // Unreachable in honest play (a line needs rounds), but a directly-created
  // covenant UTXO could carry it — belt and braces.
  req(s.pendingWin === 0, "win claim pending");
  req(s.round === 0, "game has begun");
  req(s.commit1 === ZERO_HASH && s.commit2 === ZERO_HASH, "game has begun");
  req(s.reveal1 === 0 && s.reveal2 === 0, "game has begun");
  req(ctx.signer === s.p1 || ctx.signer === s.p2, "only a player can dissolve");
  if (ctx.signer === s.p2 && s.quick === 0)
    req(ctx.utxoAge >= s.moveTimeout, "joiner must wait out the move clock");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

/**
 * Seal a pick. From the second round on, the first commit anchors the shared
 * cutoff on the round-start output's acceptance (D = S + T) and the second
 * stores max(D, S1 + G). The first round has no round-start output before
 * the first pick — the join proves the joiner's presence, and the first
 * commit proves its sender's — so its first commit stores no cutoff and the
 * second is measured from the first commit's own acceptance: D = S1 + T.
 */
export function commit(s: State, ctx: Ctx, hash: string): State {
  const score = accepted(ctx);
  const first = s.commit1 === ZERO_HASH && s.commit2 === ZERO_HASH;
  let pickDeadline: number;
  if (first) {
    req(score < s.deadline, "game limit reached");
    pickDeadline = s.round === 0 ? 0 : score + s.moveTimeout;
  } else {
    if (s.round === 0) pickDeadline = score + s.moveTimeout;
    else {
      timely(s, ctx);
      pickDeadline = s.pickDeadline;
    }
    pickDeadline = Math.max(pickDeadline, score + REBASE_GRACE_DAA);
  }
  req(pickDeadline < DEADLINE_LIMIT, "pick deadline out of range");
  return {
    ...s,
    ...legacy.commit(s, ctx, hash),
    pickDeadline,
    firstCommitter: first ? (ctx.signer === s.p1 ? 1 : 2) : s.firstCommitter,
  };
}

export function reveal(s: State, ctx: Ctx, col: number, salt: Uint8Array): State {
  timely(s, ctx);
  return { ...s, ...legacy.reveal(s, ctx, col, salt), pickDeadline: 0, firstCommitter: 0 };
}

export function resolve(s: State, ctx: Ctx, col: number, salt: Uint8Array): State {
  return { ...s, ...legacy.resolve(s, ctx, col, salt), pickDeadline: 0, firstCommitter: 0 };
}

function split(s: State): Payout[] {
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

function pays(s: State, player: number): Payout[] {
  return [{ to: player === 1 ? s.p1 : s.p2, amount: 2n * s.stake }];
}

function commitCount(s: State) {
  return Number(s.commit1 !== ZERO_HASH) + Number(s.commit2 !== ZERO_HASH);
}

function timeoutWinner(s: State, ctx: Ctx): number {
  if (s.reveal1 !== 0 || s.reveal2 !== 0) {
    req(ctx.utxoAge >= s.revealTimeout, "reveal timeout not reached");
    return s.reveal1 !== 0 ? 1 : 2;
  }
  // The first round never forfeits a pick: nobody has proven presence before
  // their first commit, so a missing or late second pick there refunds both.
  req(s.round > 0, "the first round refunds instead of forfeiting");
  const score = accepted(ctx);
  const count = commitCount(s);
  if (count === 1) {
    timely(s, ctx);
    // Waits out the second committer's rebase grace too, so a graced second
    // commit and this claim can never both stand.
    req(
      ctx.txTime >= Math.max(s.pickDeadline, score + REBASE_GRACE_DAA),
      "pick deadline not reached",
    );
  } else {
    req(count === 2 && score > s.pickDeadline, "no one-sided timeout");
  }
  req(s.firstCommitter === 1 || s.firstCommitter === 2, "invalid first committer");
  return s.firstCommitter;
}

export function claimTimeout(s: State, ctx: Ctx): Payout[] {
  req(s.p2 !== ZERO_PK, "game not started");
  req(s.pendingWin === 0 && !isBoardFull(s.board), "board result takes precedence");
  const winner = timeoutWinner(s, ctx);
  req(ctx.signer === (winner === 1 ? s.p1 : s.p2), "only the compliant player can claim");
  return pays(s, winner);
}

/** The permissionless even split: the lobby after one clock, nobody picked
 * by the cutoff, a late lone pick, both picked and nobody revealed within
 * the grace — and, in the first round only, a lone pick nobody answered
 * within the window after it, or a second pick that landed late. */
export function splitTimeout(s: State, ctx: Ctx): Payout[] {
  req(s.p2 !== ZERO_PK, "opponent has not joined");
  req(s.pendingWin === 0 && !isBoardFull(s.board), "board result takes precedence");
  req(s.reveal1 === 0 && s.reveal2 === 0, "one-sided reveal timeout");
  const count = commitCount(s);
  if (count === 0) {
    if (s.round === 0) req(ctx.utxoAge >= s.moveTimeout, "lobby timeout not reached");
    else {
      const score = accepted(ctx);
      req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
      req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
    }
  } else if (count === 1) {
    const score = accepted(ctx);
    if (s.round === 0) {
      req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
      req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
    } else req(score > s.pickDeadline, "timely first committer is owed a win");
  } else if (accepted(ctx) <= s.pickDeadline) {
    req(ctx.utxoAge >= s.revealTimeout, "reveal timeout not reached");
  } else req(s.round === 0, "late second pick is the first committer's win");
  return split(s);
}

export function claimWin(s: State, ctx: Ctx, line: LineWitness): State {
  return { ...s, ...legacy.claimWin(s, ctx, line), pickDeadline: 0, firstCommitter: 0 };
}

export const claimSplit = legacy.claimSplit;

export function claimDraw(s: State, ctx: Ctx): Payout[] {
  return legacy.claimDraw({ ...s, moveTimeout: s.revealTimeout }, ctx);
}

export function sweepWin(s: State, ctx: Ctx): Payout[] {
  return legacy.sweepWin({ ...s, moveTimeout: s.revealTimeout }, ctx);
}

/** Permissionless cleanup preserves established wins, including timed picks.
 * A final in-progress obligation may outlast the cap; it cannot be shortened
 * into a loss or converted from a forfeit into a refund by the other player. */
export function suddenDeath(s: State, ctx: Ctx): Payout[] {
  req(s.p2 !== ZERO_PK, "opponent has not joined");
  req(ctx.txTime >= s.deadline, "game limit not reached");
  if (s.pendingWin !== 0) {
    req(ctx.utxoAge >= s.revealTimeout, "challenge window still open");
    return pays(s, s.pendingWin);
  }
  if (s.reveal1 !== 0 || s.reveal2 !== 0) return pays(s, timeoutWinner(s, ctx));
  const count = commitCount(s);
  if (count === 0) {
    // Nobody has picked: wait out the same window splitTimeout does, so the
    // cap never shortens a live picking round or the lobby clock.
    if (s.round === 0) req(ctx.utxoAge >= s.moveTimeout, "lobby timeout not reached");
    else {
      const score = accepted(ctx);
      req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
      req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
    }
    return split(s);
  }
  const score = accepted(ctx);
  if (s.round === 0) {
    // The first round never forfeits: the split waits out the second pick's
    // window after a lone first commit, or the reveal grace once two timely
    // picks are in; a late second pick splits now.
    if (count === 1) {
      req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
      req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
    } else if (score <= s.pickDeadline) {
      req(ctx.utxoAge >= s.revealTimeout, "reveal window still open");
    }
    return split(s);
  }
  if (count === 1) {
    if (score > s.pickDeadline) return split(s);
    return pays(s, timeoutWinner(s, ctx));
  }
  if (score > s.pickDeadline) return pays(s, timeoutWinner(s, ctx));
  req(ctx.utxoAge >= s.revealTimeout, "reveal window still open");
  return split(s);
}

// --- Shape builders (see CONTEXT.md) -----------------------------------------
//
// The successor shapes the doors above produce, guards not included, so the
// app's engine can pose transitions it cannot authorize (an opponent's salt)
// without forking the field list.

/** A commitment by `player` on a state whose input was accepted at
 * `inputDaa`: the first commit anchors the shared cutoff (none in the first
 * round), the second stores the rebase-graced cutoff (see commit). */
export function applyCommit(s: State, player: 0 | 1, hash: string, inputDaa: number): State {
  const first = s.commit1 === ZERO_HASH && s.commit2 === ZERO_HASH;
  const pickDeadline = first
    ? s.round === 0
      ? 0
      : inputDaa + s.moveTimeout
    : Math.max(
        s.round === 0 ? inputDaa + s.moveTimeout : s.pickDeadline,
        inputDaa + REBASE_GRACE_DAA,
      );
  return {
    ...s,
    board: s.board.slice(),
    ...(player === 0 ? { commit1: hash } : { commit2: hash }),
    pickDeadline,
    firstCommitter: first ? player + 1 : s.firstCommitter,
  };
}

export function applyReveal(s: State, player: 0 | 1, col: number): State {
  return { ...s, ...legacy.applyReveal(s, player, col), pickDeadline: 0, firstCommitter: 0 };
}

export function applyResolve(s: State, player: 0 | 1, col: number): State {
  return { ...s, ...legacy.applyResolve(s, player, col), pickDeadline: 0, firstCommitter: 0 };
}

export function applyClaimWin(s: State, disc: number): State {
  return { ...s, ...legacy.applyClaimWin(s, disc), pickDeadline: 0, firstCommitter: 0 };
}

// --- Reachability ------------------------------------------------------------

function commitCountOf(s: State): number {
  return Number(s.commit1 !== ZERO_HASH) + Number(s.commit2 !== ZERO_HASH);
}

/** The V2 counterpart of validateReachableSimulState: every invariant a state
 * reachable from a legal V2 genesis satisfies, for every decoder of untrusted
 * V2 state (share codes, stored records). */
export function validateReachableSimulV2State(s: State): void {
  validateReachableSimulState(s);
  req(
    Number.isInteger(s.revealTimeout) &&
      s.revealTimeout >= MIN_MOVE_TIMEOUT_DAA &&
      s.revealTimeout <= s.moveTimeout,
    "invalid reveal timeout",
  );
  req(Number.isInteger(s.pickDeadline) && s.pickDeadline >= 0, "bad pick deadline");
  req(s.pickDeadline < DEADLINE_LIMIT, "bad pick deadline");
  req([0, 1, 2].includes(s.firstCommitter), "bad first committer");
  req(s.quick === 0 || s.quick === 1, "invalid quick flag");
  // The cutoff lives exactly as long as the round is collecting commits: the
  // first reveal, a resolve and a win claim all clear it. A lone first-round
  // commit carries none (see commit).
  const count = s.reveal1 !== 0 || s.reveal2 !== 0 ? 0 : commitCountOf(s);
  if (count === 0) req(s.pickDeadline === 0 && s.firstCommitter === 0, "cutoff without a commit");
  else {
    if (count === 1 && s.round === 0)
      req(s.pickDeadline === 0, "first-round lone commit with a cutoff");
    else req(s.pickDeadline >= s.moveTimeout, "cutoff below the picking window");
    req(s.firstCommitter === 1 || s.firstCommitter === 2, "commit without a first committer");
    if (count === 1)
      req(s.firstCommitter === (s.commit1 !== ZERO_HASH ? 1 : 2), "first committer mismatch");
  }
}
