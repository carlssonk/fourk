/**
 * Fourk V2 (shared picking deadlines), engine surface: the
 * FourkSimulV2Lobby/FourkSimulV2 actor pair.
 *
 * One structural difference from the legacy fourk engine: a commit
 * successor embeds the shared picking cutoff, which the covenant derives
 * from the SPENT UTXO's acceptance score — so re-deriving an opponent's
 * commit needs that score (Match.acceptedDaa, stamped whenever the UTXO was
 * seen alive; the adopter fetches it off the virtual chain otherwise). The
 * first round is the exception in the rules, not the plumbing: its first
 * commit stores no cutoff and its second is measured from the first
 * commit's own acceptance, so both still read the spent output's score.
 */

import { phaseOf, toHex, type Match } from "../../lib/match";
import { findWin, MIN_MOVE_TIMEOUT_DAA, type State } from "../../lib/game";
import type { ActorState, MatchTiming, SpendInfo } from "../../lib/engine";
import type { GenesisOptions, ModeChainSurface, SpendClass } from "../types";
import { rederiveJoin } from "../common";
import { legalSimulColumns, myObligation, roundPhase, simulProgress } from "../fourk/core";
import { pruneSalts } from "../fourk/saltStore";
import { core2Of, fromV2State, toV2State, v2, zeroCore2 } from "./core";

const CONTINUATIONS = new Set<string>(["commit", "reveal", "resolve", "claim_win"]);

function isOpen(s: State): boolean {
  return phaseOf(s) === 0;
}

export function v2Snapshot(m: Match): v2.State {
  return toV2State(m.state, core2Of(m));
}

/** A rules context: the signer, plus the timing facts a door reads
 * (inputDaa = the spent UTXO's acceptance score; txTime = lock time;
 * utxoAge = sequence). Zero where a door does not read them. */
export function v2Ctx(pkHex: string, inputDaa = 0, txTime = 0, utxoAge = 0): v2.Ctx {
  return { signer: pkHex, inputDaa, txTime, utxoAge };
}

/** Which player a pubkey seats, or null. */
export function playerOf(m: Match, pkHex: string): 0 | 1 | null {
  return m.state.p1 === pkHex ? 0 : m.state.p2 === pkHex ? 1 : null;
}

export const fourk2Engine = {
  actorOf(m: Match): string {
    return isOpen(m.state) ? "FourkSimulV2Lobby" : "FourkSimulV2";
  },

  /** The snapshot as the actor's state fields (contracts/fourk.ag). */
  stateOf(m: Match): ActorState {
    const s = m.state;
    const core = core2Of(m);
    if (isOpen(s))
      return {
        p1: s.p1,
        move_timeout: s.moveTimeout,
        deadline: s.deadline,
        reveal_timeout: core.revealTimeout,
        quick: core.quick,
      };
    const ss = v2Snapshot(m);
    return {
      p1: ss.p1,
      p2: ss.p2,
      board: toHex(ss.board),
      round: ss.round,
      commit1: ss.commit1,
      commit2: ss.commit2,
      reveal1: ss.reveal1,
      reveal2: ss.reveal2,
      pending_win: ss.pendingWin,
      move_timeout: ss.moveTimeout,
      deadline: ss.deadline,
      pick_deadline: ss.pickDeadline,
      first_committer: ss.firstCommitter,
      reveal_timeout: ss.revealTimeout,
      quick: ss.quick,
    };
  },

  /** The reveal grace defaults to the picking window: a reveal is owed the
   * moment both picks are in, and a shorter grace would forfeit a player
   * who committed early and stepped away in a long-clock game. */
  genesisFields(timing: MatchTiming, { quick = false }: GenesisOptions = {}): Partial<Match> {
    const revealTimeout = timing.revealTimeout ?? timing.moveTimeout;
    if (
      !Number.isInteger(revealTimeout) ||
      revealTimeout < MIN_MOVE_TIMEOUT_DAA ||
      revealTimeout > timing.moveTimeout
    )
      throw new Error("reveal grace must be between one minute and the picking window");
    return { mode: "fourk2", simul: zeroCore2(revealTimeout, quick ? 1 : 0) };
  },

  /** Quick Match waives the joiner's wait (the covenant's quick flag). */
  joinerExitWait(m: Match): number {
    return core2Of(m).quick === 1 ? 0 : m.state.moveTimeout;
  },

  /** claim_draw waits out the reveal grace (see the covenant). */
  drawAge(m: Match): number {
    return core2Of(m).revealTimeout;
  },

  joinFields(m: Match): Partial<Match> {
    return { simul: core2Of(m) };
  },

  /**
   * Enumerable successors: the round continuations as in the legacy engine.
   * The commit phase stays blind (an opponent's hash is unknowable).
   */
  successors(m: Match): Match[] {
    if (isOpen(m.state)) return [];
    const ss = v2Snapshot(m);
    if (ss.pendingWin !== 0) return [];
    const out: v2.State[] = [];
    for (const disc of [1, 2] as const) {
      if (findWin(ss.board, disc)) out.push(v2.applyClaimWin(ss, disc));
    }
    const phase = roundPhase(ss);
    if (phase === "reveal") {
      for (const player of [0, 1] as const) {
        for (const col of legalSimulColumns(ss)) out.push(v2.applyReveal(ss, player, col));
      }
    } else if (phase === "resolve") {
      const resolver = ss.reveal1 !== 0 ? 1 : 0;
      for (const col of legalSimulColumns(ss)) out.push(v2.applyResolve(ss, resolver, col));
    }
    return out.map((next) => ({ ...m, ...fromV2State(next) }));
  },

  canEnumerate(m: Match): boolean {
    if (isOpen(m.state)) return false;
    const ss = v2Snapshot(m);
    if (ss.pendingWin !== 0) return false;
    return roundPhase(ss) !== "commit";
  },

  /** Joins and the round continuations: lift the pushes, pose the successor,
   * hand it back for address verification (the adopter checks the derived
   * address holds the covenant, which is what makes this trustless). */
  rederiveSpend(m: Match, spend: SpendInfo): Match | null {
    if (spend.kind === "join") return rederiveJoin(m, spend, { simul: core2Of(m) });
    if (isOpen(m.state)) return null;
    const ss = v2Snapshot(m);
    let next: v2.State;
    try {
      if (spend.kind === "commit") {
        // ABI order: sig(65), pk(32), hash(32). The successor's cutoff is
        // derived from the spent UTXO's acceptance score.
        if (m.acceptedDaa === undefined) return null;
        const [, pk, hash] = spend.pushes;
        if (!pk || pk.length !== 32 || !hash || hash.length !== 32) return null;
        next = v2.commit(ss, v2Ctx(toHex(pk), m.acceptedDaa), toHex(hash));
      } else if (spend.kind === "reveal" || spend.kind === "resolve") {
        // ABI order: sig(65), pk(32), col (small int arg), salt(32). Posed
        // through the shape builders: the covenant already checked the
        // preimage and the timing, and the address check verifies the rest.
        const [, pk] = spend.pushes;
        const col = spend.args[0];
        if (!pk || pk.length !== 32 || col === undefined) return null;
        const player = playerOf(m, toHex(pk));
        if (player === null) return null;
        next =
          spend.kind === "reveal"
            ? v2.applyReveal(ss, player, col)
            : v2.applyResolve(ss, player, col);
      } else if (spend.kind === "claim_win") {
        const [wcol, wrow] = spend.args;
        if (wcol === undefined || wrow === undefined) return null;
        if (wcol < 0 || wcol >= 7 || wrow < 0 || wrow >= 6) return null;
        const disc = ss.board[wcol * 6 + wrow];
        if (disc !== 1 && disc !== 2) return null;
        next = v2.applyClaimWin(ss, disc);
      } else {
        return null; // terminal door — the watcher classifies it instead
      }
    } catch {
      return null; // spend contradicts our snapshot — resync from scratch
    }
    return { ...m, ...fromV2State(next) };
  },

  needsAcceptedDaa(_m: Match, spend: SpendInfo): boolean {
    return spend.kind === "commit";
  },

  classifySpend(spend: SpendInfo | null): SpendClass {
    return !spend || CONTINUATIONS.has(spend.kind) ? "continuation" : "terminal";
  },

  progress(m: Match): number {
    return simulProgress(core2Of(m));
  },

  /** The round obligations as in the legacy engine: a joined lobby owes
   * both players their first pick. */
  isActionable(m: Match, pkHex: string): boolean {
    if (isOpen(m.state)) return false;
    return myObligation(m.state, core2Of(m), pkHex) !== null;
  },

  onMatchesPruned(keptCovenantIds: string[]): void {
    pruneSalts(keptCovenantIds);
  },
} satisfies ModeChainSurface;
