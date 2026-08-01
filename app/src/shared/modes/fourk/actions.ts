/**
 * Fourk mode, player actions. Each runs the reference rules on the current
 * (state, core) pair to derive the honest successor, then submits the
 * matching entry. The salt is persisted BEFORE the commit broadcast: a
 * browser that loses it cannot reveal and forfeits the round by timeout.
 */

import { CELLS, findWin, isOpen, type LineWitness } from "../../lib/game";
import { fromHex, toHex, type Match } from "../../lib/match";
import * as engine from "../../lib/engine";
import { ensureFunds } from "../../lib/dispenser";
import type { AutoAction, AutoCtx, DropResult, ModeActions } from "../types";
import { fourkEngine, simulCtx, simulSnapshot } from "./engine";
import { coreOf, myObligation, priorityPlayer } from "./core";
import { commitmentOf, fromSimulState, roundPhase, simulCommit, simulResolve, simulReveal } from "./core";
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

/** Claim a completed line on the current board. The covenant pays the line's
 * owner (who must be the signer), wherever they direct it. */
export async function claimWinMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  w: LineWitness,
): Promise<string> {
  return engine.signedTerminal(rpc, key, fourkEngine, match, "claim_win", [w.col, w.row, w.dir]);
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
    await ensureFunds(rpc, key, engine.FEE_HEADROOM);
    return { kind: "continued", match: await commitMatch(rpc, key, match, col) };
  },

  claimTimeout: claimTimeoutMatch,
};

/**
 * Fourk's round duties. Reveals and resolves fire the moment they're owed
 * (the pick was already made at commit time) — with etiquette: in the reveal
 * phase BOTH players owe a reveal and would race the same UTXO, so the
 * round's priority player goes first and the other holds back a beat (their
 * duty flips to "resolve" when the first reveal lands; if the priority
 * player is gone, the delayed reveal still goes out). Finished lines are
 * claimed as soon as they exist: mine alone takes the pot (claim_win, keyed
 * to the line's owner); one line per colour is the double win and splits
 * (claim_split, permissionless). An opponent's lone line is theirs to claim.
 */
export function fourkAutoActions(m: Match, ctx: AutoCtx): AutoAction[] {
  const out: AutoAction[] = [];
  if (isOpen(m.state)) return out;
  const core = coreOf(m);
  const full = m.state.moveCount >= CELLS;
  const myIdx = ctx.role === "p2" ? 1 : 0;

  const obligation = full ? null : myObligation(m.state, core, ctx.myPk);
  if (
    (obligation === "reveal" || obligation === "resolve") &&
    loadSalt(m.covenantId, core.round)
  )
    out.push({
      key: "reveal",
      oncePer: "utxo",
      ...(obligation === "reveal" &&
        myIdx !== priorityPlayer(core.round) && { delayMs: 2000 }),
      run: async (rpc, key, mm) => {
        await ensureFunds(rpc, key, engine.FEE_HEADROOM);
        return { kind: "advanced", match: await revealMatch(rpc, key, mm) };
      },
    });

  const myDisc = myIdx === 0 ? 1 : 2;
  const mine = findWin(m.state.board, myDisc);
  if (mine) {
    const theirs = findWin(m.state.board, 3 - myDisc);
    out.push({
      key: "claim",
      oncePer: "utxo",
      run: async (rpc, key, mm) => {
        if (theirs) {
          await ensureFunds(rpc, key, engine.FEE_HEADROOM);
          const w1 = myIdx === 0 ? mine : theirs;
          const w2 = myIdx === 0 ? theirs : mine;
          await claimSplitMatch(rpc, key, mm, w1, w2);
          return {
            kind: "finished",
            message: "You both connected four in the same drop — the pot split evenly.",
          };
        }
        await claimWinMatch(rpc, key, mm, mine);
        return { kind: "finished", message: "You connected four — you win! 🎉" };
      },
    });
  }
  return out;
}
