/** Versioned shared-deadline Fourk rulebook. Legacy matches keep src/simul. */
import * as legacy from "../simul/rules.js";
import { newSimulMatch, type SimulState, ZERO_HASH, isBoardFull } from "../simul/state.js";
import { DEADLINE_LIMIT, MIN_MOVE_TIMEOUT_DAA, ZERO_PK, type PubKey } from "../state.js";
import type { Ctx as LegacyCtx, Payout, LineWitness } from "../rules.js";

/** Second-commit rebase grace in DAA (~10 s): commits serialize on one UTXO,
 * so a first commit accepted late in the window forces the opponent's commit
 * to be rebuilt on its output. The second cutoff is the later of the shared
 * deadline and the first commit's acceptance plus this grace, and the first
 * committer's timeout claim waits for that same score. */
export const REBASE_GRACE_DAA = 100;

export interface State extends SimulState {
  readyMask: number;
  pickDeadline: number;
  firstCommitter: number;
  revealTimeout: number;
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
): State {
  req(
    Number.isInteger(revealTimeout) &&
      revealTimeout >= MIN_MOVE_TIMEOUT_DAA &&
      revealTimeout <= moveTimeout,
    "invalid reveal timeout",
  );
  return {
    ...newSimulMatch(p1, stake, moveTimeout, deadline),
    readyMask: 0,
    pickDeadline: 0,
    firstCommitter: 0,
    revealTimeout,
  };
}

export function join(s: State, ctx: Ctx): State {
  req(
    Number.isInteger(s.revealTimeout) &&
      s.revealTimeout >= MIN_MOVE_TIMEOUT_DAA &&
      s.revealTimeout <= s.moveTimeout,
    "invalid reveal timeout",
  );
  req(s.readyMask === 0 && s.pickDeadline === 0 && s.firstCommitter === 0, "invalid lobby state");
  return { ...s, ...legacy.join(s, ctx) };
}

export const cancel = legacy.cancel;

export function ready(s: State, ctx: Ctx): State {
  req(s.p2 !== ZERO_PK, "opponent has not joined");
  req(
    Number.isInteger(s.readyMask) && s.readyMask >= 0 && s.readyMask < 3,
    "invalid readiness or game already started",
  );
  req(
    s.round === 0 &&
      s.pendingWin === 0 &&
      s.commit1 === ZERO_HASH &&
      s.commit2 === ZERO_HASH &&
      s.reveal1 === 0 &&
      s.reveal2 === 0,
    "invalid ready phase",
  );
  req(ctx.signer === s.p1 || ctx.signer === s.p2, "only a player can ready");
  const bit = ctx.signer === s.p1 ? 1 : 2;
  req((s.readyMask & bit) === 0, "already ready");
  return { ...s, board: s.board.slice(), readyMask: s.readyMask | bit };
}

export function dissolve(s: State, ctx: Ctx) {
  req(s.readyMask !== 3, "game already started");
  return legacy.dissolve(s, ctx);
}

export function commit(s: State, ctx: Ctx, hash: string): State {
  req(s.readyMask === 3, "both players must be ready");
  const score = accepted(ctx);
  const first = s.commit1 === ZERO_HASH && s.commit2 === ZERO_HASH;
  let pickDeadline: number;
  if (first) {
    req(score < s.deadline, "game limit reached");
    pickDeadline = score + s.moveTimeout;
  } else {
    timely(s, ctx);
    pickDeadline = Math.max(s.pickDeadline, score + REBASE_GRACE_DAA);
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
  req(s.readyMask === 3, "both players must be ready");
  timely(s, ctx);
  return { ...s, ...legacy.reveal(s, ctx, col, salt), pickDeadline: 0, firstCommitter: 0 };
}

export function resolve(s: State, ctx: Ctx, col: number, salt: Uint8Array): State {
  req(s.readyMask === 3, "both players must be ready");
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
  req(s.readyMask === 3 && s.p2 !== ZERO_PK, "game not started");
  req(s.pendingWin === 0 && !isBoardFull(s.board), "board result takes precedence");
  const winner = timeoutWinner(s, ctx);
  req(ctx.signer === (winner === 1 ? s.p1 : s.p2), "only the compliant player can claim");
  return pays(s, winner);
}

export function splitTimeout(s: State, ctx: Ctx): Payout[] {
  req(s.p2 !== ZERO_PK, "opponent has not joined");
  req(s.pendingWin === 0 && !isBoardFull(s.board), "board result takes precedence");
  req(s.reveal1 === 0 && s.reveal2 === 0, "one-sided reveal timeout");
  if (s.readyMask !== 3) {
    req(ctx.utxoAge >= s.moveTimeout, "lobby timeout not reached");
  } else {
    const score = accepted(ctx);
    const count = commitCount(s);
    if (count === 0) {
      req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
      req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
    } else if (count === 1) {
      req(score > s.pickDeadline, "timely first committer is owed a win");
    } else {
      timely(s, ctx);
      req(ctx.utxoAge >= s.revealTimeout, "reveal timeout not reached");
    }
  }
  return split(s);
}

export function claimWin(s: State, ctx: Ctx, line: LineWitness): State {
  req(s.readyMask === 3, "game not started");
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
  if (count === 1) {
    if (accepted(ctx) > s.pickDeadline) return split(s);
    return pays(s, timeoutWinner(s, ctx));
  }
  if (count === 2) {
    if (accepted(ctx) > s.pickDeadline) return pays(s, timeoutWinner(s, ctx));
    req(ctx.utxoAge >= s.revealTimeout, "reveal window still open");
    return split(s);
  }
  // Nobody has picked: wait out the same window splitTimeout does, so the cap
  // never shortens a live picking round or the lobby clock.
  if (s.readyMask !== 3) {
    req(ctx.utxoAge >= s.moveTimeout, "lobby timeout not reached");
  } else {
    const score = accepted(ctx);
    req(score + s.moveTimeout < DEADLINE_LIMIT, "pick deadline out of range");
    req(ctx.txTime >= score + s.moveTimeout, "pick deadline not reached");
  }
  return split(s);
}
