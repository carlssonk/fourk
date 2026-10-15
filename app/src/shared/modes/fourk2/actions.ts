/**
 * Fourk V2, player actions and automatic duties. Every door runs the
 * reference rules on the current (state, core) pair with the SAME timing
 * facts the covenant reads — the spent UTXO's acceptance score, the lock
 * time, the sequence — so a spend that the reference rejects is never
 * built, and one it accepts carries exactly the gates the covenant checks.
 */

import { CELLS, findWin, isDoubleWin, isOpen, type LineWitness } from "../../lib/game";
import { fromHex, isStaked, toHex, type Match } from "../../lib/match";
import * as engine from "../../lib/engine";
import { ensureFunds } from "../../lib/dispenser";
import type { AutoAction, AutoCtx, DropResult, ModeActions } from "../types";
import { commitmentOf, myObligation, priorityPlayer, roundPhase } from "../fourk/core";
import { loadSalt, saveSalt } from "../fourk/saltStore";
import { commitCount, core2Of, fromV2State, v2 } from "./core";
import { fourk2Engine, v2Ctx, v2Snapshot } from "./engine";
import {
  FIRST_ROUND_LATE_MESSAGE,
  FIRST_ROUND_STALL_MESSAGE,
  capOwner,
  lateFirstCommit,
  lateSecondCommit,
  lonePickScore,
} from "./view";

async function liveEntry(rpc: engine.Rpc, m: Match): Promise<engine.UtxoEntryLike> {
  const entry = await engine.fetchGameUtxo(rpc, fourk2Engine, m);
  if (!entry) throw new Error("game UTXO not found on chain. Sync first");
  return entry;
}

/** A lock-time-gated spend is refused by the mempool ("not finalized")
 * until the chain passes the lock; say so before building it. The
 * reference cannot catch this — it is told the lock time we chose. */
async function assertLockReached(rpc: engine.Rpc, lockTime: bigint): Promise<void> {
  if (lockTime === 0n) return;
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  const now = BigInt(info.virtualDaaScore);
  // Consensus finalizes a lock time only once the score is PAST it
  // (lock_time < DAA score, tx_validation_in_header_context.rs).
  if (now <= lockTime) {
    const mins = Math.max(1, Math.ceil(Number(lockTime + 1n - now) / 600));
    throw new Error(`pick deadline not reached (about ${mins} minute${mins === 1 ? "" : "s"})`);
  }
}

/** Seal a pick. The successor's cutoff derives from the current UTXO's
 * acceptance score, so the entry is read first and handed to the builder.
 * Straight from the joined lobby too: the first pick to land starts the
 * other player's window. */
export async function commitMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  col: number,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const entry = await liveEntry(rpc, match);
  const accepted = engine.entryAcceptedDaa(entry);
  const ss = v2Snapshot(match);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const player = pkHex === ss.p1 ? 0 : 1;
  const h = commitmentOf(player, col, salt);
  saveSalt(match.covenantId, ss.round, col, toHex(salt));
  const next = fromV2State(v2.commit(ss, v2Ctx(pkHex, accepted), h));
  return engine.continuation(
    rpc,
    key,
    fourk2Engine,
    match,
    "commit",
    [{ sig: 0 }, { bytes: pkHex }, { bytes: h }],
    next,
    0n,
    "",
    { gameUtxo: entry },
  );
}

/** Reveal or resolve, whichever the round calls for. A reveal proves the
 * second commit was timely (its acceptance score against the cutoff); the
 * reference throws "pick arrived late" where the covenant would refuse. */
export async function revealMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const entry = await liveEntry(rpc, match);
  const accepted = engine.entryAcceptedDaa(entry);
  const ss = v2Snapshot(match);
  const rec = loadSalt(match.covenantId, ss.round);
  if (!rec) throw new Error("this round's secret pick is not stored in this browser");
  const salt = fromHex(rec.salt);
  const resolving = roundPhase(ss) === "resolve";
  const next = fromV2State(
    resolving
      ? v2.resolve(ss, v2Ctx(pkHex, accepted), rec.col, salt)
      : v2.reveal(ss, v2Ctx(pkHex, accepted), rec.col, salt),
  );
  return engine.continuation(
    rpc,
    key,
    fourk2Engine,
    match,
    resolving ? "resolve" : "reveal",
    [{ sig: 0 }, { bytes: pkHex }, { int: rec.col }, { bytes: rec.salt }],
    next,
    0n,
    "",
    { gameUtxo: entry },
  );
}

export async function claimWinMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  w: LineWitness,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const next = fromV2State(v2.claimWin(v2Snapshot(match), v2Ctx(pkHex), w));
  return engine.continuation(
    rpc,
    key,
    fourk2Engine,
    match,
    "claim_win",
    [{ sig: 0 }, { int: w.col }, { int: w.row }, { int: w.dir }],
    next,
    0n,
  );
}

/** Sweep a pending win once the challenge window (the reveal grace) lapsed.
 * Permissionless: the covenant pins the pot to the pending winner, so either
 * player's client (or anyone) can send it — no key needed. */
export async function sweepWinMatch(rpc: engine.Rpc, match: Match): Promise<string> {
  const core = core2Of(match);
  const winner = core.pendingWin === 1 ? match.state.p1 : match.state.p2;
  return engine.pinnedWinner(rpc, fourk2Engine, match, "sweep_win", winner, {
    sequence: BigInt(core.revealTimeout),
  });
}

export async function claimSplitMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  w1: LineWitness,
  w2: LineWitness,
): Promise<string> {
  return engine.pinnedSplit(rpc, key, fourk2Engine, match, "claim_split", [
    { int: w1.col },
    { int: w1.row },
    { int: w1.dir },
    { int: w2.col },
    { int: w2.row },
    { int: w2.dir },
  ]);
}

/** The score a lone pick's settlement waits for, given the pick's
 * observed acceptance (see lonePickScore; never null with a stamp). */
function lonePickLock(match: Match, accepted: number): bigint {
  return BigInt(lonePickScore({ ...match, acceptedDaa: accepted }) ?? 0);
}

/** The gates a timeout claim carries, per state: a reveal on the table is
 * relative (the reveal grace as sequence); a lone timely commit is absolute
 * (lock time at the cutoff or the rebase grace, whichever is later); a late
 * second commit needs neither — the spent UTXO's own score proves it. */
function timeoutGates(match: Match, accepted: number): { lockTime: bigint; sequence: bigint } {
  const core = core2Of(match);
  if (core.reveal1 !== 0 || core.reveal2 !== 0)
    return { lockTime: 0n, sequence: BigInt(core.revealTimeout) };
  if (commitCount(core) === 1) return { lockTime: lonePickLock(match, accepted), sequence: 0n };
  return { lockTime: 0n, sequence: 0n };
}

/** The opponent is late on a one-sided obligation: a lone timely commit
 * past the cutoff, a second commit accepted after it, or a missing resolve. */
export async function claimTimeoutMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  const pkHex = engine.walletPubkey(key);
  const entry = await liveEntry(rpc, match);
  const accepted = engine.entryAcceptedDaa(entry);
  const { lockTime, sequence } = timeoutGates(match, accepted);
  // The reference refuses with the covenant's reason before anything is built.
  v2.claimTimeout(v2Snapshot(match), v2Ctx(pkHex, accepted, Number(lockTime), Number(sequence)));
  await assertLockReached(rpc, lockTime);
  return engine.signedTerminal(
    rpc,
    key,
    fourk2Engine,
    match,
    "claim_timeout",
    [{ sig: 0 }],
    sequence,
    { lockTime, gameUtxo: entry },
  );
}

/** The symmetric stalls: nobody picked by the cutoff, the lone pick landed
 * late, or both picked and nobody revealed within the grace; the joined
 * lobby after one clock; and the first round's refunds — a lone pick nobody
 * answered within its window, or a second pick that landed late.
 * Permissionless even split. */
function splitGates(match: Match, accepted: number): { lockTime: bigint; sequence: bigint } {
  const core = core2Of(match);
  const count = commitCount(core);
  const window = BigInt(accepted + match.state.moveTimeout);
  if (count === 0)
    return core.round === 0
      ? { lockTime: 0n, sequence: BigInt(match.state.moveTimeout) }
      : { lockTime: window, sequence: 0n };
  if (count === 1)
    return core.round === 0 ? { lockTime: window, sequence: 0n } : { lockTime: 0n, sequence: 0n };
  if (accepted > core.pickDeadline) return { lockTime: 0n, sequence: 0n };
  return { lockTime: 0n, sequence: BigInt(core.revealTimeout) };
}

export async function splitTimeoutMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  const entry = await liveEntry(rpc, match);
  const accepted = engine.entryAcceptedDaa(entry);
  const { lockTime, sequence } = splitGates(match, accepted);
  v2.splitTimeout(v2Snapshot(match), v2Ctx("", accepted, Number(lockTime), Number(sequence)));
  await assertLockReached(rpc, lockTime);
  return engine.pinnedSplit(rpc, key, fourk2Engine, match, "split_timeout", [], {
    lockTime,
    sequence,
    gameUtxo: entry,
  });
}

/** The whole-game cap. Beyond the deadline it also carries whichever gate
 * the state's own settlement would: it never shortens an owed window, and
 * it pays a decided timeout winner (or pending winner) in full. */
function capGates(match: Match, accepted: number): { lockTime: bigint; sequence: bigint } {
  const core = core2Of(match);
  const deadline = BigInt(match.state.deadline);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  if (core.pendingWin !== 0 || core.reveal1 !== 0 || core.reveal2 !== 0)
    return { lockTime: deadline, sequence: BigInt(core.revealTimeout) };
  const count = commitCount(core);
  const late = accepted > core.pickDeadline;
  const window = BigInt(accepted + match.state.moveTimeout);
  if (count === 0)
    return core.round === 0
      ? { lockTime: deadline, sequence: BigInt(match.state.moveTimeout) }
      : { lockTime: max(deadline, window), sequence: 0n };
  if (count === 1)
    return late && core.round > 0
      ? { lockTime: deadline, sequence: 0n }
      : { lockTime: max(deadline, lonePickLock(match, accepted)), sequence: 0n };
  return late
    ? { lockTime: deadline, sequence: 0n }
    : { lockTime: deadline, sequence: BigInt(core.revealTimeout) };
}

export async function suddenDeathMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  const entry = await liveEntry(rpc, match);
  const accepted = engine.entryAcceptedDaa(entry);
  const { lockTime, sequence } = capGates(match, accepted);
  const payouts = v2.suddenDeath(
    v2Snapshot(match),
    v2Ctx("", accepted, Number(lockTime), Number(sequence)),
  );
  await assertLockReached(rpc, lockTime);
  if (payouts.length === 1)
    return engine.pinnedWinner(rpc, fourk2Engine, match, "sudden_death", payouts[0]!.to, {
      lockTime,
      sequence,
      gameUtxo: entry,
    });
  return engine.pinnedSplit(rpc, key, fourk2Engine, match, "sudden_death", [], {
    lockTime,
    sequence,
    gameUtxo: entry,
  });
}

/** The chain score a cap settlement must reach before it can be submitted
 * (a lock-time-gated transaction is refused by the mempool until then). */
async function capWaitMs(rpc: engine.Rpc, m: Match): Promise<number> {
  const entry = await engine.fetchGameUtxo(rpc, fourk2Engine, m);
  if (!entry) return 3000;
  const accepted = engine.entryAcceptedDaa(entry);
  const { lockTime, sequence } = capGates(m, accepted);
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  const now = Number(info.virtualDaaScore);
  const lockWait = Number(lockTime) + 1 - now; // final once the score is past it
  const ageWait = Number(sequence) - (now - accepted);
  // Past-deadline claims fire now; the pad lets the node's clock catch up.
  return Math.max(0, Math.max(lockWait, ageWait) * 100 + 2000);
}

export const fourk2Actions: ModeActions = {
  async drop(rpc, key, match, col): Promise<DropResult> {
    await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(match) });
    return { kind: "continued", match: await commitMatch(rpc, key, match, col) };
  },
  claimTimeout: claimTimeoutMatch,
  settleCap: suddenDeathMatch,
  async collectWait(rpc, m, myPk) {
    const core = core2Of(m);
    if (core.pendingWin === 0 || isOpen(m.state)) return null;
    if ((core.pendingWin === 1 ? m.state.p1 : m.state.p2) !== myPk) return null;
    // A double win is a split, not a sweep — the game's contest settles it.
    if (isDoubleWin(m.state.board)) return null;
    const age = await engine.gameUtxoAge(rpc, fourk2Engine, m);
    if (age === null) return null;
    return Math.max(0, core.revealTimeout - age);
  },
  async collect(rpc, m) {
    if (isDoubleWin(m.state.board)) throw new Error("A double win splits; open the game to settle it.");
    // Already gone: every door out of a single-line pending win pays the
    // winner (sweep_win, or sudden_death to the pending owner; claim_split
    // needs a second line on this same committed board), so it was paid.
    if (await engine.fetchGameUtxo(rpc, fourk2Engine, m)) await sweepWinMatch(rpc, m);
    return WIN_MESSAGE;
  },
};

/** How much longer the loser's client waits before sweeping, so the winner's
 * own client usually sends it first. */
const LOSER_SWEEP_DELAY_DAA = 50;

export const SPLIT_MESSAGE = "You both connected four in the same drop. The pot split evenly.";
const WIN_MESSAGE = "You connected four. You win!";
const LOSS_MESSAGE = "Your opponent connected four.";
const NO_PICKS_MESSAGE = "Neither player picked before the timer ended. The pot split evenly.";
const STALL_MESSAGE = "The game stalled on both sides. It timed out and the pot split evenly.";

/**
 * Fourk V2's automatic duties. Reveals, resolves and win claims as in the
 * legacy mode; the contest and the sweep on a pending win; and — new — the
 * permissionless splits of a stalled round, which are all draws: nobody
 * picked by the cutoff, the lone pick landed late, both picked and nobody
 * can reveal within the grace, and the first round's refunds. The joined
 * lobby keeps its manual exits (kick, cancel); nothing splits it.
 */
export function fourk2AutoActions(m: Match, ctx: AutoCtx): AutoAction[] {
  const out: AutoAction[] = [];
  if (isOpen(m.state)) return out;
  const core = core2Of(m);
  const myIdx = ctx.role === "p2" ? 1 : 0;
  const myDisc = myIdx === 0 ? 1 : 2;

  if (core.pendingWin !== 0) {
    const p1Line = findWin(m.state.board, 1);
    const p2Line = findWin(m.state.board, 2);
    if (p1Line && p2Line) {
      out.push({
        key: "contest",
        oncePer: "utxo",
        run: async (rpc, key, mm) => {
          await claimSplitMatch(rpc, key, mm, p1Line, p2Line);
          return { kind: "finished", message: SPLIT_MESSAGE };
        },
      });
    } else {
      // Either player sends the sweep — it can only pay the winner, so a
      // winner who closed the game is still paid by the opponent's client.
      // The loser waits a little longer so the winner's own client usually
      // lands it first and the two do not race for the same UTXO.
      const mine = core.pendingWin === myDisc;
      out.push({
        key: "sweep",
        oncePer: "match",
        scheduleMs: async (rpc) => {
          const age = await engine.gameUtxoAge(rpc, fourk2Engine, m);
          if (age === null) return 3000;
          const slack = mine ? 0 : LOSER_SWEEP_DELAY_DAA;
          if (age >= core.revealTimeout + slack) return 0;
          return (core.revealTimeout + slack - age) * 100 + 2000;
        },
        run: async (rpc, _key, mm) => {
          await sweepWinMatch(rpc, mm);
          return { kind: "finished", message: mine ? WIN_MESSAGE : LOSS_MESSAGE };
        },
      });
    }
    return out;
  }

  const full = m.state.moveCount >= CELLS;
  const obligation = full ? null : myObligation(m.state, core, ctx.myPk);
  const salt = loadSalt(m.covenantId, core.round);
  const phase = roundPhase(v2Snapshot(m));
  if ((obligation === "reveal" || obligation === "resolve") && salt && !lateSecondCommit(m))
    out.push({
      key: "reveal",
      oncePer: "utxo",
      ...(obligation === "reveal" && myIdx !== priorityPlayer(core.round) && { delayMs: 2000 }),
      run: async (rpc, key, mm) => {
        // A second commit that landed after the cutoff cannot be revealed;
        // stamp the score so the view says so and the claim can proceed.
        if (obligation === "reveal") {
          const entry = await engine.fetchGameUtxo(rpc, fourk2Engine, mm);
          if (entry && engine.entryAcceptedDaa(entry) > core2Of(mm).pickDeadline)
            return { kind: "advanced", match: engine.withEntry(mm, entry) };
        }
        await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(mm) });
        return { kind: "advanced", match: await revealMatch(rpc, key, mm) };
      },
    });

  const mine = findWin(m.state.board, myDisc);
  if (mine) {
    const theirs = findWin(m.state.board, 3 - myDisc);
    out.push({
      key: "claim",
      oncePer: "utxo",
      run: async (rpc, key, mm) => {
        await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(mm) });
        if (theirs) {
          const w1 = myIdx === 0 ? mine : theirs;
          const w2 = myIdx === 0 ? theirs : mine;
          await claimSplitMatch(rpc, key, mm, w1, w2);
          return { kind: "finished", message: SPLIT_MESSAGE };
        }
        return { kind: "advanced", match: await claimWinMatch(rpc, key, mm, mine) };
      },
    });
  }

  // The stalled-round splits. Self-funded (fee from the pot), so no top-up.
  if (!full && phase === "commit" && commitCount(core) === 0 && core.round > 0) {
    out.push({
      key: "no-picks",
      oncePer: "utxo",
      scheduleMs: async (rpc) => {
        const age = await engine.gameUtxoAge(rpc, fourk2Engine, m);
        if (age === null) return 3000;
        return Math.max(0, (m.state.moveTimeout - age) * 100 + 2000);
      },
      run: async (rpc, key, mm) => {
        await splitTimeoutMatch(rpc, key, mm);
        return { kind: "finished", message: NO_PICKS_MESSAGE };
      },
    });
  } else if (!full && lateFirstCommit(m)) {
    out.push({
      key: "late-pick",
      oncePer: "utxo",
      run: async (rpc, key, mm) => {
        await splitTimeoutMatch(rpc, key, mm);
        return { kind: "finished", message: NO_PICKS_MESSAGE };
      },
    });
  } else if (!full && core.round === 0 && phase === "commit" && commitCount(core) === 1) {
    // The first round's lone pick: the refund waits out the picking window
    // after it (the lone-commit UTXO's age, which is what the lock reads).
    out.push({
      key: "first-round-stall",
      oncePer: "utxo",
      scheduleMs: async (rpc) => {
        const age = await engine.gameUtxoAge(rpc, fourk2Engine, m);
        if (age === null) return 3000;
        return Math.max(0, (m.state.moveTimeout - age) * 100 + 2000);
      },
      run: async (rpc, key, mm) => {
        await splitTimeoutMatch(rpc, key, mm);
        return { kind: "finished", message: FIRST_ROUND_STALL_MESSAGE };
      },
    });
  } else if (!full && core.round === 0 && lateSecondCommit(m)) {
    out.push({
      key: "first-round-late",
      oncePer: "utxo",
      run: async (rpc, key, mm) => {
        await splitTimeoutMatch(rpc, key, mm);
        return { kind: "finished", message: FIRST_ROUND_LATE_MESSAGE };
      },
    });
  } else if (!full && phase === "reveal" && !salt && !lateSecondCommit(m)) {
    out.push({
      key: "no-reveals",
      oncePer: "utxo",
      scheduleMs: async (rpc) => {
        const age = await engine.gameUtxoAge(rpc, fourk2Engine, m);
        if (age === null) return 3000;
        return Math.max(0, (core.revealTimeout - age) * 100 + 2000);
      },
      run: async (rpc, key, mm) => {
        await splitTimeoutMatch(rpc, key, mm);
        return { kind: "finished", message: STALL_MESSAGE };
      },
    });
  }
  return out;
}

/** The cap crank, scheduled on the exact gate the settlement carries. */
export function fourk2CapAction(m: Match, myPk: string): AutoAction[] {
  if (isOpen(m.state) || m.state.deadline <= 0) return [];
  // Personal, like describeEnd's: the result classifier reads "you took"
  // and "your opponent took" as the win and the loss.
  const message = (mm: Match) => {
    const owner = capOwner(mm);
    if (owner === 0)
      return "Time's up. The game hit its total time limit and the pot split evenly.";
    return (owner === 1 ? mm.state.p1 : mm.state.p2) === myPk
      ? "Time's up. The game hit its total time limit and you took the pot."
      : "Time's up. The game hit its total time limit and your opponent took the pot.";
  };
  return [
    {
      key: "sudden-death",
      oncePer: "match",
      scheduleMs: (rpc) => capWaitMs(rpc, m),
      run: async (rpc, key, mm) => {
        await suddenDeathMatch(rpc, key, mm);
        return { kind: "finished", message: message(mm) };
      },
    },
  ];
}
