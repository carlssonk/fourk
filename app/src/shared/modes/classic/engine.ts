/**
 * Classic mode, engine surface: alternating turns, one disc per move, the
 * FourkLobby/FourkMatch actor pair. The unnamed default of the pre-mode app,
 * now named.
 */

import { fourk } from "../../lib/sdk";
import { applyMove, legalColumns, playerToMove, type State } from "../../lib/game";
import { fromHex, phaseOf, toHex, type Match } from "../../lib/match";
import type { SpendInfo } from "../../lib/engine";
import type { ModeChainSurface, SpendClass } from "../types";
import { rederiveJoin } from "../common";

/** Entrypoints in ABI/selector order — must match fourk.ag declaration order
 * per actor (each generated contract numbers its own selectors from 0). */
const LOBBY_ENTRYPOINTS = ["join", "cancel"] as const;
const MATCH_ENTRYPOINTS = [
  "dissolve",
  "move",
  "winning_move",
  "claim_draw",
  "claim_forfeit",
  "sudden_death",
] as const;

function isOpen(s: State): boolean {
  return phaseOf(s) === 0;
}

function classicArgs(s: State): [Uint8Array, Uint8Array, Uint8Array, bigint, bigint, bigint] {
  return [
    fromHex(s.p1),
    fromHex(s.p2),
    s.board,
    BigInt(s.moveCount),
    BigInt(s.moveTimeout),
    BigInt(s.deadline),
  ];
}

export const classicEngine = {
  covenantBudget: 12,

  lockRedeem(m: Match): Uint8Array {
    const s = m.state;
    return isOpen(s)
      ? fourk.lobbyLockScript(fromHex(s.p1), BigInt(s.moveTimeout), BigInt(s.deadline))
      : fourk.matchLockScript(...classicArgs(s));
  },

  sigScript(
    m: Match,
    fn: string,
    sig: Uint8Array | undefined,
    pk: Uint8Array | undefined,
    ints: number[],
  ): string {
    const s = m.state;
    const intArgs = ints.length ? BigInt64Array.from(ints.map(BigInt)) : undefined;
    return toHex(
      isOpen(s)
        ? fourk.lobbySigScript(
            fromHex(s.p1),
            BigInt(s.moveTimeout),
            BigInt(s.deadline),
            fn,
            sig,
            pk,
          )
        : fourk.matchSigScript(...classicArgs(s), fn, sig, pk, intArgs),
    );
  },

  selectorTable(m: Match): readonly string[] {
    return isOpen(m.state) ? LOBBY_ENTRYPOINTS : MATCH_ENTRYPOINTS;
  },

  genesisFields(): Partial<Match> {
    return {};
  },

  joinFields(_m: Match): Partial<Match> {
    return {};
  },

  /** Every live successor is a legal move of the player to move. */
  successors(m: Match): Match[] {
    if (isOpen(m.state)) return [];
    return legalColumns(m.state).map((c) => ({ ...m, state: applyMove(m.state, c) }));
  },

  /** Only the join (the unknown joiner pubkey) is blind. */
  canEnumerate(m: Match): boolean {
    return !isOpen(m.state);
  },

  rederiveSpend(m: Match, spend: SpendInfo): Match | null {
    return rederiveJoin(m, spend, {});
  },

  /** Only a TRACED terminal door reads as an ending. An untraceable spend
   * (pruned checkpoint, UTXO-index race, a node that can't serve the trace)
   * proves nothing: declaring it terminal would persist "The game has
   * ended." onto a live match — and in a staked game the player who stops
   * playing then loses the pot to claim_forfeit. Continuations (join, and
   * any move whose adoption failed) retry too. */
  classifySpend(spend: SpendInfo | null): SpendClass {
    return !spend || spend.kind === "join" || spend.kind === "move" ? "continuation" : "terminal";
  },

  progress(m: Match): number {
    return m.state.moveCount;
  },

  isActionable(m: Match, pkHex: string): boolean {
    const mover = playerToMove(m.state) === 0 ? m.state.p1 : m.state.p2;
    return mover === pkHex;
  },
} satisfies ModeChainSurface;
