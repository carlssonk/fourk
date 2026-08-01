/**
 * Fourk mode, engine surface: simultaneous commit-reveal rounds on the
 * FourkSimulLobby/FourkSimul actor pair.
 *
 * The one structural wrinkle relative to classic: the COMMIT phase is blind
 * (a successor embeds the opponent's unpredictable 32-byte hash), so
 * successors() is empty there and spends must be traced and re-derived
 * (rederiveSpend) — the same treatment joins get in every mode.
 */

import { fourk } from "../../lib/sdk";
import { fromHex, phaseOf, toHex, type Match } from "../../lib/match";
import type { State } from "../../lib/game";
import type { SpendInfo } from "../../lib/engine";
import type { GameMode, SpendClass } from "../types";
import { rederiveJoin } from "../common";
import {
  ZERO_CORE,
  ZERO_HASH,
  applyResolution,
  coreOf,
  fromSimulState,
  legalSimulColumns,
  myObligation,
  roundPhase,
  simulCommit,
  simulProgress,
  simulResolve,
  simulReveal,
  toSimulState,
  type SimulCore,
  type SimulState,
} from "./core";
import { pruneSalts } from "./saltStore";

/** Entrypoints in ABI/selector order — must match fourk.ag declaration order
 * per actor (each generated contract numbers its own selectors from 0).
 * Note `split_timeout`: a real covenant door with no app affordance yet —
 * symmetric stalls are settled by whichever CLI/client cranks it. */
const SIMUL_LOBBY_ENTRYPOINTS = ["join", "cancel"] as const;
const SIMUL_MATCH_ENTRYPOINTS = [
  "dissolve",
  "commit",
  "reveal",
  "resolve",
  "claim_win",
  "claim_split",
  "claim_draw",
  "claim_timeout",
  "split_timeout",
  "sudden_death",
] as const;

const CONTINUATIONS = new Set<string>(["commit", "reveal", "resolve"]);

function isOpen(s: State): boolean {
  return phaseOf(s) === 0;
}

function simulArgs(
  ss: SimulState,
): [Uint8Array, Uint8Array, Uint8Array, bigint, Uint8Array, Uint8Array, bigint, bigint, bigint, bigint] {
  return [
    fromHex(ss.p1),
    fromHex(ss.p2),
    ss.board,
    BigInt(ss.round),
    fromHex(ss.commit1),
    fromHex(ss.commit2),
    BigInt(ss.reveal1),
    BigInt(ss.reveal2),
    BigInt(ss.moveTimeout),
    BigInt(ss.deadline),
  ];
}

export function simulSnapshot(m: Match): SimulState {
  return toSimulState(m.state, coreOf(m));
}

export function simulCtx(pkHex: string) {
  return { signer: pkHex, utxoAge: 0, txTime: 0 };
}

export const fourkEngine = {
  /** Fourk continuations rebuild the ~4.3 KB successor template in-script
   * (~131k units measured live for join — budget 12 caps at 129,999), so
   * the declared budget is 20 for comfortable headroom. */
  covenantBudget: 20,

  lockRedeem(m: Match): Uint8Array {
    const s = m.state;
    return isOpen(s)
      ? fourk.simulLobbyLockScript(fromHex(s.p1), BigInt(s.moveTimeout), BigInt(s.deadline))
      : fourk.simulMatchLockScript(...simulArgs(simulSnapshot(m)));
  },

  sigScript(
    m: Match,
    fn: string,
    sig: Uint8Array | undefined,
    pk: Uint8Array | undefined,
    ints: number[],
    blob?: Uint8Array,
  ): string {
    const s = m.state;
    const intArgs = ints.length ? BigInt64Array.from(ints.map(BigInt)) : undefined;
    return toHex(
      isOpen(s)
        ? fourk.simulLobbySigScript(
            fromHex(s.p1),
            BigInt(s.moveTimeout),
            BigInt(s.deadline),
            fn,
            sig,
            pk,
          )
        : fourk.simulMatchSigScript(...simulArgs(simulSnapshot(m)), fn, sig, pk, blob, intArgs),
    );
  },

  selectorTable(m: Match): readonly string[] {
    return isOpen(m.state) ? SIMUL_LOBBY_ENTRYPOINTS : SIMUL_MATCH_ENTRYPOINTS;
  },

  genesisFields(): Partial<Match> {
    return { mode: "fourk", simul: ZERO_CORE };
  },

  joinFields(m: Match): Partial<Match> {
    return { simul: coreOf(m) };
  },

  /**
   * Enumerable successors. Commit-phase successors embed the opponent's
   * hash and CANNOT be enumerated. Reveal-phase successors are (player ×
   * legal column) firsts; resolve-phase successors are the ≤7 resolutions
   * of the pending reveal.
   */
  successors(m: Match): Match[] {
    if (isOpen(m.state)) return [];
    const ss = simulSnapshot(m);
    const phase = roundPhase(ss);
    if (phase === "commit") return [];
    const out: Array<{ state: State; simul: SimulCore }> = [];
    if (phase === "reveal") {
      for (const player of [0, 1] as const) {
        for (const col of legalSimulColumns(ss)) {
          // The commitment's preimage is unknown; pose the successor the
          // covenant would enforce for this (player, col) reveal.
          const next = { ...ss, board: ss.board.slice() } as SimulState;
          if (player === 0) {
            next.commit1 = ZERO_HASH;
            next.reveal1 = col + 1;
          } else {
            next.commit2 = ZERO_HASH;
            next.reveal2 = col + 1;
          }
          out.push(fromSimulState(next));
        }
      }
    } else {
      // One reveal on the table: the other player resolves with any legal column.
      const revealer = ss.reveal1 !== 0 ? 0 : 1;
      const revealedCol = (revealer === 0 ? ss.reveal1 : ss.reveal2) - 1;
      for (const col of legalSimulColumns(ss)) {
        out.push(
          fromSimulState({
            ...ss,
            board: applyResolution(ss.board, ss.round, revealedCol, revealer, col),
            round: ss.round + 1,
            commit1: ZERO_HASH,
            commit2: ZERO_HASH,
            reveal1: 0,
            reveal2: 0,
          }),
        );
      }
    }
    return out.map((next) => ({ ...m, state: next.state, simul: next.simul }));
  },

  canEnumerate(m: Match): boolean {
    return !isOpen(m.state) && roundPhase(simulSnapshot(m)) !== "commit";
  },

  /** Joins plus the round continuations: lift the pushes, replay the
   * reference rules, hand back the successor for address verification. */
  rederiveSpend(m: Match, spend: SpendInfo): Match | null {
    if (spend.kind === "join") return rederiveJoin(m, spend, { simul: coreOf(m) });
    if (isOpen(m.state)) return null;
    const ss = simulSnapshot(m);
    let next: SimulState;
    try {
      if (spend.kind === "commit") {
        // ABI order: sig(65), pk(32), hash(32).
        const [, pk, hash] = spend.pushes;
        if (!pk || pk.length !== 32 || !hash || hash.length !== 32) return null;
        next = simulCommit(ss, simulCtx(toHex(pk)), toHex(hash));
      } else if (spend.kind === "reveal" || spend.kind === "resolve") {
        // ABI order: sig(65), pk(32), col (small int arg), salt(32).
        const [, pk] = spend.pushes;
        const salt = spend.pushes[spend.pushes.length - 1];
        const col = spend.args[0];
        if (!pk || pk.length !== 32 || !salt || salt.length !== 32 || col === undefined)
          return null;
        next =
          spend.kind === "reveal"
            ? simulReveal(ss, simulCtx(toHex(pk)), col, salt)
            : simulResolve(ss, simulCtx(toHex(pk)), col, salt);
      } else {
        return null; // terminal door — the watcher classifies it instead
      }
    } catch {
      return null; // spend contradicts our snapshot — resync from scratch
    }
    return { ...m, ...fromSimulState(next) };
  },

  /** Continuations (and untraceable spends — commit-phase blind spots and
   * index races look identical) must never read as endings: skip and retry. */
  classifySpend(spend: SpendInfo | null): SpendClass {
    return !spend || CONTINUATIONS.has(spend.kind) ? "continuation" : "terminal";
  },

  progress(m: Match): number {
    return simulProgress(coreOf(m));
  },

  isActionable(m: Match, pkHex: string): boolean {
    return myObligation(m.state, coreOf(m), pkHex) !== null;
  },

  onMatchesPruned(keptCovenantIds: string[]): void {
    pruneSalts(keptCovenantIds);
  },
} satisfies Omit<GameMode, "meta">;
