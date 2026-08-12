/**
 * The match actions through the ChainOps/AccountOps seam (state/deps.ts) —
 * the money-safety branches that previously only ran against a live chain:
 * takeSeat's refuse-before-funds-move guards and createGame's guest/staked
 * split. No node, no wasm: the fakes are the seam's second adapter. Lives
 * under app/ because the modules resolve "kaspa-wasm" from the app
 * workspace.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { createGame, errorAtom, takeSeat } from "../src/shared/state/actions";
import { currentMatchAtom, matchesAtom } from "../src/shared/state/matches";
import { stakeAtom } from "../src/shared/state/profile";
import type { AccountOps, ChainOps, Deps } from "../src/shared/state/deps";
import type { Wallet } from "../src/shared/state/wallet";
import type { PrivateKey } from "../src/shared/lib/covenant";
import { FREE_STAKE, SOMPI_PER_KAS, type Match } from "../src/shared/lib/match";
import { CELLS, ZERO_PK } from "../src/shared/lib/game";

const store = getDefaultStore();

// The state layer is import-safe (initStateLayer never runs here); only the
// persistence helpers touched by successful actions still want storage.
const bag = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
});

const OWNED_PK = "11".repeat(32);
const GUEST_PK = "33".repeat(32);
const HOST_PK = "44".repeat(32);

/** Keys never reach a real signer here — an id-carrying stand-in is enough
 * for the fakes to tell wallets apart. */
const keyOf = (id: string) => ({ id }) as unknown as PrivateKey;
const walletOf = (id: string, myPk: string): Wallet => ({ key: keyOf(id), myPk });

const matchAt = (over: Partial<Match["state"]> = {}, value?: bigint): Match => {
  const state = {
    p1: HOST_PK,
    p2: ZERO_PK,
    board: new Uint8Array(CELLS),
    moveCount: 0,
    stake: FREE_STAKE,
    moveTimeout: 36_000,
    deadline: 500_000,
    ...over,
  };
  return {
    network: "testnet-10",
    covenantId: "ab".repeat(32),
    txid: "cd".repeat(32),
    state,
    value: value ?? (state.p2 === ZERO_PK ? state.stake : state.stake * 2n),
  };
};

function fakeChain(over: Partial<ChainOps> = {}): ChainOps {
  return {
    connect: vi.fn(async () => {}),
    ensureFunds: vi.fn(async () => {}),
    chainCheckpoint: vi.fn(async () => "ee".repeat(32)),
    openMatch: vi.fn(async (_key, stake) => matchAt({ stake })),
    joinMatch: vi.fn(async (_key, invite: Match) => ({
      ...invite,
      state: { ...invite.state, p2: GUEST_PK },
      value: invite.state.stake * 2n,
    })),
    assertJoinableDeadline: vi.fn(async () => {}),
    ...over,
  };
}

function fakeAccount(over: Partial<AccountOps> = {}): AccountOps {
  const owned = walletOf("owned", OWNED_PK);
  return {
    hasOwnedAccount: () => true,
    signingWallet: (opts) => (opts.staked ? owned : walletOf("guest", GUEST_PK)),
    matchWallet: () => undefined,
    ...over,
  };
}

const deps = (chain: ChainOps, account: AccountOps): Deps => ({ chain, account });

beforeEach(() => {
  bag.clear();
  vi.useRealTimers();
  store.set(matchesAtom, []);
  store.set(currentMatchAtom, null);
  store.set(errorAtom, null);
  store.set(stakeAtom, 0n);
});

describe("createGame", () => {
  test("a guest hosts free, whatever the remembered stake says", async () => {
    store.set(stakeAtom, 5n * SOMPI_PER_KAS);
    const chain = fakeChain();
    const signingWallet = vi.fn(() => walletOf("guest", GUEST_PK));
    await createGame(deps(chain, fakeAccount({ hasOwnedAccount: () => false, signingWallet })));
    expect(signingWallet).toHaveBeenCalledWith({ staked: false });
    expect(chain.ensureFunds).toHaveBeenCalledWith(
      expect.anything(),
      FREE_STAKE + SOMPI_PER_KAS / 2n,
      {
        staked: false,
      },
    );
    expect(chain.openMatch).toHaveBeenCalledWith(
      expect.anything(),
      FREE_STAKE,
      expect.anything(),
      expect.anything(),
    );
    expect(store.get(currentMatchAtom)).not.toBeNull();
  });

  test("an owned account with a stake hosts staked, funded from its own balance", async () => {
    store.set(stakeAtom, 5n * SOMPI_PER_KAS);
    const chain = fakeChain();
    const signingWallet = vi.fn(() => walletOf("owned", OWNED_PK));
    await createGame(deps(chain, fakeAccount({ signingWallet })));
    expect(signingWallet).toHaveBeenCalledWith({ staked: true });
    expect(chain.ensureFunds).toHaveBeenCalledWith(
      expect.anything(),
      5n * SOMPI_PER_KAS + SOMPI_PER_KAS / 2n,
      {
        staked: true,
      },
    );
    expect(chain.openMatch).toHaveBeenCalledWith(
      expect.anything(),
      5n * SOMPI_PER_KAS,
      expect.anything(),
      expect.anything(),
    );
  });

  test("the pre-open checkpoint is saved for the watcher", async () => {
    const chain = fakeChain();
    await createGame(deps(chain, fakeAccount({ hasOwnedAccount: () => false })));
    const cps = JSON.parse(bag.get("fourk.checkpoints") ?? "{}");
    expect(Object.values(cps)).toContain("ee".repeat(32));
  });
});

describe("takeSeat", () => {
  test("a spent deadline refuses the seat before any funds move", async () => {
    const chain = fakeChain({
      assertJoinableDeadline: vi.fn(async () => {
        throw new Error("DEADLINE_TOO_CLOSE");
      }),
    });
    await takeSeat(matchAt(), deps(chain, fakeAccount()));
    expect(store.get(errorAtom)).not.toBeNull();
    expect(chain.ensureFunds).not.toHaveBeenCalled();
    expect(chain.joinMatch).not.toHaveBeenCalled();
  });

  test("a vanished genesis UTXO reads as 'seat no longer open', not a sync error", async () => {
    const chain = fakeChain({
      joinMatch: vi.fn(async () => {
        throw new Error("game UTXO not found");
      }),
    });
    await takeSeat(matchAt(), deps(chain, fakeAccount()));
    expect(store.get(errorAtom)).toContain("no longer open");
  });

  test("a known game just reopens — the chain is never asked", async () => {
    const known = matchAt({ p2: GUEST_PK, moveCount: 4 });
    store.set(matchesAtom, [known]);
    const chain = fakeChain();
    await takeSeat(matchAt({ p2: GUEST_PK }), deps(chain, fakeAccount()));
    expect(store.get(currentMatchAtom)?.state.moveCount).toBe(4);
    expect(chain.connect).not.toHaveBeenCalled();
  });

  test("a filled seat means spectating — no key resolved, no funds", async () => {
    const chain = fakeChain();
    const signingWallet = vi.fn(() => walletOf("guest", GUEST_PK));
    await takeSeat(matchAt({ p2: GUEST_PK }), deps(chain, fakeAccount({ signingWallet })));
    expect(signingWallet).not.toHaveBeenCalled();
    expect(chain.connect).not.toHaveBeenCalled();
    expect(store.get(currentMatchAtom)).not.toBeNull();
  });

  test("the host reopening their own open game does not join against themselves", async () => {
    const invite = matchAt();
    const chain = fakeChain();
    const account = fakeAccount({ matchWallet: () => walletOf("host", HOST_PK) });
    await takeSeat(invite, deps(chain, account));
    expect(chain.joinMatch).not.toHaveBeenCalled();
    expect(store.get(currentMatchAtom)).not.toBeNull();
  });

  test("joining an open seat funds it and shows the joined match", async () => {
    const chain = fakeChain();
    await takeSeat(matchAt(), deps(chain, fakeAccount()));
    expect(store.get(errorAtom)).toBeNull();
    expect(chain.assertJoinableDeadline).toHaveBeenCalled();
    expect(chain.joinMatch).toHaveBeenCalled();
    expect(store.get(currentMatchAtom)?.state.p2).toBe(GUEST_PK);
  });
});
