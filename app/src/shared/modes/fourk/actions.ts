/**
 * Fourk mode, player actions. Each runs the reference rules on the current
 * (state, core) pair to derive the honest successor, then submits the
 * matching entry. The salt is persisted BEFORE the commit broadcast: a
 * browser that loses it cannot reveal and forfeits the round by timeout.
 */

import { CELLS, findWin, isOpen, type LineWitness } from "../../lib/game";
import { fromHex, isStaked, toHex, type Match } from "../../lib/match";
import * as engine from "../../lib/engine";
import { ensureFunds } from "../../lib/dispenser";
import type { AutoAction, AutoCtx, DropResult, ModeActions } from "../types";
import { fourkEngine, simulCtx, simulSnapshot } from "./engine";
import { coreOf, myObligation, priorityPlayer } from "./core";
import {
  commitmentOf,
  fromSimulState,
  roundPhase,
  simulClaimWin,
  simulCommit,
  simulResolve,
  simulReveal,
} from "./core";
import { loadSalt, saveSalt } from "./saltStore";

export async function commitMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  col: number,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const ss = simulSnapshot(match);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const h = commitmentOf(col, salt);
  saveSalt(match.covenantId, ss.round, col, toHex(salt));
  const next = fromSimulState(simulCommit(ss, simulCtx(pkHex), h));
  return engine.continuation(
    rpc,
    key,
    fourkEngine,
    match,
    "commit",
    () => ({ pk: fromHex(pkHex), ints: [], blob: fromHex(h) }),
    next,
    0n,
  );
}

/** Reveal or resolve, whichever the round phase calls for. Throws if this
 * browser never stored the round's salt (committed elsewhere). */
export async function revealMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const ss = simulSnapshot(match);
  const rec = loadSalt(match.covenantId, ss.round);
  if (!rec) throw new Error("this round's secret pick is not stored in this browser");
  const salt = fromHex(rec.salt);
  const resolving = roundPhase(ss) === "resolve";
  const next = fromSimulState(
    resolving
      ? simulResolve(ss, simulCtx(pkHex), rec.col, salt)
      : simulReveal(ss, simulCtx(pkHex), rec.col, salt),
  );
  return engine.continuation(
    rpc,
    key,
    fourkEngine,
    match,
    resolving ? "resolve" : "reveal",
    () => ({ pk: fromHex(pkHex), ints: [rec.col], blob: salt }),
    next,
    0n,
  );
}

/** Claim a completed line on the current board: opens the challenge window.
 * The pot parks in a pending-win successor for one move clock — claim_split
 * (the permissionless double-win contest) can convert it to the fair split
 * inside the window, and sweepWinMatch pays out once it lapses. */
export async function claimWinMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  w: LineWitness,
): Promise<Match> {
  const pkHex = engine.walletPubkey(key);
  const ss = simulSnapshot(match);
  const next = fromSimulState(simulClaimWin(ss, simulCtx(pkHex), w));
  return engine.continuation(
    rpc,
    key,
    fourkEngine,
    match,
    "claim_win",
    () => ({ ints: [w.col, w.row, w.dir] }),
    next,
    0n,
  );
}

/** Sweep a pending win whose challenge window has lapsed. The sequence field
 * carries the age proof, exactly like claim_timeout. */
export async function sweepWinMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  return engine.signedTerminal(
    rpc,
    key,
    fourkEngine,
    match,
    "sweep_win",
    [],
    BigInt(match.state.moveTimeout),
  );
}

/** The double win — both colors completed a line in one round. Two witnesses
 * (w1 = p1's line, w2 = p2's), pot splits, permissionless. */
export async function claimSplitMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  w1: LineWitness,
  w2: LineWitness,
): Promise<string> {
  return engine.pinnedSplit(rpc, key, fourkEngine, match, "claim_split", [
    w1.col,
    w1.row,
    w1.dir,
    w2.col,
    w2.row,
    w2.dir,
  ]);
}

/** The opponent is late on a one-sided obligation — the compliant player
 * (this signer) takes the pot. */
export async function claimTimeoutMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  return engine.signedTerminal(
    rpc,
    key,
    fourkEngine,
    match,
    "claim_timeout",
    [],
    BigInt(match.state.moveTimeout),
  );
}

export const fourkActions: ModeActions = {
  /** A drop seals a commitment; the board itself moves only on resolution. */
  async drop(rpc, key, match, col): Promise<DropResult> {
    await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(match) });
    return { kind: "continued", match: await commitMatch(rpc, key, match, col) };
  },

  claimTimeout: claimTimeoutMatch,
};

export const SPLIT_MESSAGE = "You both connected four in the same drop — the pot split evenly.";
const WIN_MESSAGE = "You connected four — you win! 🎉";

/**
 * Fourk's round duties. Reveals and resolves fire the moment they're owed
 * (the pick was already made at commit time) — with etiquette: in the reveal
 * phase BOTH players owe a reveal and would race the same UTXO, so the
 * round's priority player goes first and the other holds back a beat (their
 * duty flips to "resolve" when the first reveal lands; if the priority
 * player is gone, the delayed reveal still goes out).
 *
 * Wins run through the challenge window. A lone line of mine opens it
 * (claim_win — a continuation, not an ending); a line per colour is the
 * double win and splits directly (claim_split, permissionless). On a
 * PENDING state: if both lines exist, ANY client contests it into the fair
 * split — this is the duty that makes a greedy one-line claim pointless —
 * and the pending winner sweeps once the window lapses.
 */
export function fourkAutoActions(m: Match, ctx: AutoCtx): AutoAction[] {
  const out: AutoAction[] = [];
  if (isOpen(m.state)) return out;
  const core = coreOf(m);
  const myIdx = ctx.role === "p2" ? 1 : 0;
  const myDisc = myIdx === 0 ? 1 : 2;

  if (core.pendingWin !== 0) {
    // The round machine is suspended; the only duties are the window's.
    const p1Line = findWin(m.state.board, 1);
    const p2Line = findWin(m.state.board, 2);
    if (p1Line && p2Line) {
      out.push({
        key: "contest",
        oncePer: "utxo",
        run: async (rpc, key, mm) => {
          await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(mm) });
          await claimSplitMatch(rpc, key, mm, p1Line, p2Line);
          return { kind: "finished", message: SPLIT_MESSAGE };
        },
        onTerminated: SPLIT_MESSAGE,
      });
    } else if (core.pendingWin === myDisc) {
      out.push({
        key: "sweep",
        oncePer: "match",
        scheduleMs: async (rpc) => {
          const age = await engine.gameUtxoAge(rpc, fourkEngine, m);
          // The +2s pad lets the chain tick past the sequence lock before
          // the age-gated tx is submitted.
          return Math.max(0, (m.state.moveTimeout - (age ?? 0)) * 100 + 2000);
        },
        run: async (rpc, key, mm) => {
          await ensureFunds(rpc, key, engine.FEE_HEADROOM, { staked: isStaked(mm) });
          await sweepWinMatch(rpc, key, mm);
          return { kind: "finished", message: WIN_MESSAGE };
        },
      });
    }
    return out;
  }

  const full = m.state.moveCount >= CELLS;
  const obligation = full ? null : myObligation(m.state, core, ctx.myPk);
  if ((obligation === "reveal" || obligation === "resolve") && loadSalt(m.covenantId, core.round))
    out.push({
      key: "reveal",
      oncePer: "utxo",
      ...(obligation === "reveal" && myIdx !== priorityPlayer(core.round) && { delayMs: 2000 }),
      run: async (rpc, key, mm) => {
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
        // Opens the window; the sweep duty takes over on the pending state.
        return { kind: "advanced", match: await claimWinMatch(rpc, key, mm, mine) };
      },
    });
  }
  return out;
}
