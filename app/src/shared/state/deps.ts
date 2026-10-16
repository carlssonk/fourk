/**
 * The seam behind the match actions (CONTEXT.md: ChainOps / AccountOps).
 *
 * ChainOps owns the connection: `connect()` is the explicit "Connecting to
 * the Kaspa network" step, and every other call resolves it internally — no
 * RpcClient appears in the interface. AccountOps answers which key signs
 * what. Two adapters make the seam real: the covenant facade bound to the
 * live RPC here, and in-memory fakes in the tests.
 */

import * as cov from "../lib/covenant";
import { ensureFunds } from "../lib/dispenser";
import type { Match, PlayerProfile } from "../lib/match";
import type { GameModeKey, GenesisOptions } from "../modes/types";
import { getRpc } from "./rpc";
import { hasOwnedAccount, matchWallet, signingWallet, type Wallet } from "./wallet";
import type { MatchTiming, PrivateKey } from "../lib/covenant";

export interface ChainOps {
  /** Resolve the node connection — the step the connect journey ticks on. */
  connect(): Promise<void>;
  /** Top a key's address up to `need`, from the dispenser (free) or the
   * owned balance (staked). */
  ensureFunds(key: PrivateKey, need: bigint, opts: { staked: boolean }): Promise<void>;
  chainCheckpoint(): Promise<string>;
  openMatch(
    key: PrivateKey,
    stake: bigint,
    timing: MatchTiming,
    modeKey: GameModeKey,
    onSubmit?: (m: Match) => void,
    genesis?: GenesisOptions,
  ): Promise<Match>;
  /** `onSubmit` sees the record-to-be just before the transaction leaves,
   * so it can be stored first (a reload mid-submit must not lose it). */
  joinMatch(
    key: PrivateKey,
    invite: Match,
    profile: PlayerProfile,
    onSubmit?: (m: Match) => void,
  ): Promise<Match>;
  /** Refuse a game with less than `minRemaining` (or the general floor) of
   * its time limit left. */
  assertJoinableDeadline(invite: Match, minRemaining?: number): Promise<void>;
  /** Close our own open lobby and take the stake back. */
  cancelMatch(key: PrivateKey, match: Match): Promise<void>;
}

export interface AccountOps {
  hasOwnedAccount(): boolean;
  signingWallet(opts: { staked?: boolean }): Wallet;
  matchWallet(m: Match): Wallet | undefined;
}

export interface Deps {
  chain: ChainOps;
  account: AccountOps;
}

/** Where a Quick Match ticket stands (app/sweeper/match.ts). */
export type PollState =
  { state: "waiting" | "host" | "hosted" | "matched" | "gone" } | { state: "join"; code: string };

/** The matchmaker route on our node (docs/adr/0003). */
export interface MatchmakerOps {
  /** Join the queue as `pk`; returns the ticket to poll. */
  seek(pk: string): Promise<string>;
  poll(ticket: string): Promise<PollState>;
  /** Post the host's lobby: `retry` until the matchmaker's node has it. */
  hosted(ticket: string, code: string): Promise<"ok" | "retry" | "refused">;
}

export interface QuickMatchDeps extends Deps {
  matchmaker: MatchmakerOps;
}

export const realChain: ChainOps = {
  async connect() {
    await getRpc();
  },
  async ensureFunds(key, need, opts) {
    await ensureFunds(await getRpc(), key, need, opts);
  },
  async chainCheckpoint() {
    return cov.chainCheckpoint(await getRpc());
  },
  async openMatch(key, stake, timing, modeKey, onSubmit, genesis) {
    return cov.openMatch(await getRpc(), key, stake, timing, modeKey, onSubmit, genesis);
  },
  async joinMatch(key, invite, profile, onSubmit) {
    return cov.joinMatch(await getRpc(), key, invite, profile, onSubmit);
  },
  async assertJoinableDeadline(invite, minRemaining) {
    await cov.assertJoinableDeadline(await getRpc(), invite, minRemaining);
  },
  async cancelMatch(key, match) {
    await cov.cancelMatch(await getRpc(), key, match);
  },
};

export const realAccount: AccountOps = {
  hasOwnedAccount,
  signingWallet,
  matchWallet,
};

export const realDeps: Deps = { chain: realChain, account: realAccount };
