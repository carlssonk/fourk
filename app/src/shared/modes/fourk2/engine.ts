/**
 * Fourk V2 (shared picking deadlines), engine surface: the
 * FourkSimulV2Lobby/FourkSimulV2 actor pair.
 *
 * Two structural differences from the legacy fourk engine. Both players
 * sign readiness before the first timed round (an enumerable phase: two
 * successors). And a commit successor embeds the shared picking cutoff,
 * which the covenant derives from the SPENT UTXO's acceptance score — so
 * re-deriving an opponent's commit needs that score (Match.acceptedDaa,
 * stamped whenever the UTXO was seen alive; the adopter fetches it off the
 * virtual chain otherwise).
 */

import { phaseOf, toHex, type Match } from "../../lib/match";
import { findWin, MIN_MOVE_TIMEOUT_DAA, type State } from "../../lib/game";
import type { ActorState, MatchTiming, SpendInfo } from "../../lib/engine";
import type { ModeChainSurface, SpendClass } from "../types";
import { rederiveJoin } from "../common";
import { legalSimulColumns, myObligation, roundPhase, simulProgress } from "../fourk/core";
import { pruneSalts } from "../fourk/saltStore";
import { core2Of, fromV2State, toV2State, v2, zeroCore2 } from "./core";

const CONTINUATIONS = new Set<string>(["ready", "commit", "reveal", "resolve", "claim_win"]);

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
      ready_mask: ss.readyMask,
      pick_deadline: ss.pickDeadline,
      first_committer: ss.firstCommitter,
      reveal_timeout: ss.revealTimeout,
    };
  },

  /** The reveal grace defaults to the picking window: a reveal is owed the
   * moment both picks are in, and a shorter grace would forfeit a player
   * who committed early and stepped away in a long-clock game. */
  genesisFields(timing: MatchTiming): Partial<Match> {
    const revealTimeout = timing.revealTimeout ?? timing.moveTimeout;
    if (
      !Number.isInteger(revealTimeout) ||
      revealTimeout < MIN_MOVE_TIMEOUT_DAA ||
      revealTimeout > timing.moveTimeout
    )
      throw new Error("reveal grace must be between one minute and the picking window");
    return { mode: "fourk2", simul: zeroCore2(revealTimeout) };
  },

  /** claim_draw waits out the reveal grace (see the covenant). */
  drawAge(m: Match): number {
    return core2Of(m).revealTimeout;
  },

  joinFields(m: Match): Partial<Match> {
    return { simul: core2Of(m) };
  },

  /**
   * Enumerable successors: readiness (one per unset bit), then the round
   * continuations as in the legacy engine. The commit phase stays blind (an
   * opponent's hash is unknowable).
   */
  successors(m: Match): Match[] {
    if (isOpen(m.state)) return [];
    const ss = v2Snapshot(m);
    if (ss.pendingWin !== 0) return [];
    const out: v2.State[] = [];
    if (ss.readyMask !== 3) {
      for (const player of [0, 1] as const) {
        if ((ss.readyMask & (player + 1)) === 0) out.push(v2.applyReady(ss, player));
      }
      return out.map((next) => ({ ...m, ...fromV2State(next) }));
    }
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
    return ss.readyMask !== 3 || roundPhase(ss) !== "commit";
  },

  /** Joins, readiness and the round continuations: lift the pushes, pose the
   * successor, hand it back for address verification (the adopter checks the
   * derived address holds the covenant, which is what makes this trustless). */
  rederiveSpend(m: Match, spend: SpendInfo): Match | null {
    if (spend.kind === "join") return rederiveJoin(m, spend, { simul: core2Of(m) });
    if (isOpen(m.state)) return null;
    const ss = v2Snapshot(m);
    let next: v2.State;
    try {
      if (spend.kind === "ready") {
        // ABI order: sig(65), pk(32).
        const [, pk] = spend.pushes;
        if (!pk || pk.length !== 32) return null;
        const player = playerOf(m, toHex(pk));
        if (player === null) return null;
        next = v2.ready(ss, v2Ctx(toHex(pk)));
      } else if (spend.kind === "commit") {
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

  /** Readiness bits order the pre-game snapshots; once both are ready the
   * legacy round key takes over (scaled so it always outranks them). */
  progress(m: Match): number {
    const core = core2Of(m);
    return simulProgress(core) * 4 + core.readyMask;
  },

  /** Before the first round a seat owes its readiness; afterwards the round
   * obligations apply as in the legacy engine. */
  isActionable(m: Match, pkHex: string): boolean {
    if (isOpen(m.state)) return false;
    const core = core2Of(m);
    const player = playerOf(m, pkHex);
    if (player === null) return false;
    if (core.readyMask !== 3) return (core.readyMask & (player + 1)) === 0;
    return myObligation(m.state, core, pkHex) !== null;
  },

  onMatchesPruned(keptCovenantIds: string[]): void {
    pruneSalts(keptCovenantIds);
  },
} satisfies ModeChainSurface;
