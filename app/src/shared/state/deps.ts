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
import type { GameModeKey } from "../modes/types";
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
  ): Promise<Match>;
  joinMatch(key: PrivateKey, invite: Match, profile: PlayerProfile): Promise<Match>;
  assertJoinableDeadline(invite: Match): Promise<void>;
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
  async openMatch(key, stake, timing, modeKey) {
    return cov.openMatch(await getRpc(), key, stake, timing, modeKey);
  },
  async joinMatch(key, invite, profile) {
    return cov.joinMatch(await getRpc(), key, invite, profile);
  },
  async assertJoinableDeadline(invite) {
    await cov.assertJoinableDeadline(await getRpc(), invite);
  },
};

export const realAccount: AccountOps = {
  hasOwnedAccount,
  signingWallet,
  matchWallet,
};

export const realDeps: Deps = { chain: realChain, account: realAccount };
