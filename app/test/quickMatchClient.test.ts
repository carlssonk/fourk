/**
 * The Quick Match loop (docs/adr/0003) through the Deps seam: a scripted
 * matchmaker beside the in-memory chain and account fakes. No node, no
 * network; timers are faked so the poll loop runs on demand.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { busyAtom, errorAtom } from "../src/shared/state/actions";
import {
  currentMatchAtom,
  matchesAtom,
  pendingInviteAtom,
  updateMatch,
} from "../src/shared/state/matches";
import { quickMatchAtom, startQuickMatch, stopQuickMatch } from "../src/shared/state/quickMatch";
import type {
  AccountOps,
  ChainOps,
  MatchmakerOps,
  PollState,
  QuickMatchDeps,
} from "../src/shared/state/deps";
import type { Wallet } from "../src/shared/state/wallet";
import type { PrivateKey } from "../src/shared/lib/covenant";
import { CELLS, ZERO_PK } from "../src/shared/lib/game";
import { FREE_STAKE, NETWORK_ID, encodeShareCode, type Match } from "../src/shared/lib/match";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";

const store = getDefaultStore();

const bag = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
});

const GUEST_PK = "33".repeat(32);
const keyOf = (id: string) => ({ id }) as unknown as PrivateKey;
const walletOf = (id: string, myPk: string): Wallet => ({
  key: keyOf(id),
  myPk,
});

function fakeChain(over: Partial<ChainOps> = {}): ChainOps {
  return {
    connect: vi.fn(async () => {}),
    ensureFunds: vi.fn(async () => {}),
    chainCheckpoint: vi.fn(async () => "ee".repeat(32)),
    openMatch: vi.fn(),
    joinMatch: vi.fn(),
    assertJoinableDeadline: vi.fn(async () => {}),
    cancelMatch: vi.fn(async () => {}),
    ...over,
  };
}

/** An account holder: Quick Match must still seat the guest key. */
function fakeAccount(): AccountOps {
  return {
    hasOwnedAccount: () => true,
    signingWallet: (opts) =>
      opts.staked ? walletOf("owned", "11".repeat(32)) : walletOf("guest", GUEST_PK),
    matchWallet: () => undefined,
  };
}

/** A matchmaker that answers polls from a script, repeating the last. */
function fakeMatchmaker(polls: PollState[]): MatchmakerOps {
  let i = 0;
  return {
    seek: vi.fn(async () => "t1"),
    poll: vi.fn(async () => polls[Math.min(i++, polls.length - 1)]!),
    hosted: vi.fn(async () => "ok" as const),
  };
}

const HOST_PK = "44".repeat(32);

/** The Quick Match lobby `p1` opened. */
const lobby = (p1: string, moveTimeout = 3_000): Match => ({
  network: NETWORK_ID,
  mode: "fourk2",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE,
  state: {
    p1,
    p2: ZERO_PK,
    board: new Uint8Array(CELLS),
    moveCount: 0,
    stake: FREE_STAKE,
    moveTimeout,
    deadline: 900_000,
  },
  simul: zeroCore2(moveTimeout),
});

let deps: QuickMatchDeps;

beforeEach(() => {
  bag.clear();
  vi.useFakeTimers();
  store.set(matchesAtom, []);
  store.set(currentMatchAtom, null);
  store.set(errorAtom, null);
  store.set(busyAtom, false);
  store.set(pendingInviteAtom, null);
});

afterEach(async () => {
  stopQuickMatch();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

test("seeks with the guest key, even for an account holder", async () => {
  const matchmaker = fakeMatchmaker([{ state: "waiting" }]);
  deps = { chain: fakeChain(), account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(matchmaker.seek).toHaveBeenCalledWith(GUEST_PK);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
  expect(matchmaker.poll).toHaveBeenCalledWith("t1");
});

test("a host opens a lobby on the Quick Match terms and stays home until it's taken", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([
    { state: "host" },
    { state: "host" },
    { state: "hosted" },
    { state: "matched" },
  ]);
  vi.mocked(matchmaker.hosted).mockResolvedValueOnce("retry");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(chain.openMatch).toHaveBeenCalledTimes(1);
  expect(chain.openMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    FREE_STAKE,
    expect.objectContaining({ moveTimeout: 3_000 }),
    "fourk2",
    expect.any(Function),
  );
  // On record (a reload must find it), but not on screen yet.
  expect(store.get(matchesAtom).map((m) => m.covenantId)).toEqual([opened.covenantId]);
  expect(store.get(currentMatchAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "setting-up" });
  await vi.advanceTimersByTimeAsync(10_000);
  // Posted again after the matchmaker's node hadn't seen it yet.
  expect(matchmaker.hosted).toHaveBeenCalledTimes(2);
  expect(vi.mocked(matchmaker.hosted).mock.calls[1]).toEqual(["t1", expect.any(String)]);
  // No join on record within the wait: the game opens as it stands.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(store.get(currentMatchAtom)?.covenantId).toBe(opened.covenantId);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

const joinedBy = (pk: string) =>
  vi.fn(async (_key: PrivateKey, invite: Match) => ({
    ...invite,
    state: { ...invite.state, p2: pk },
    value: invite.state.stake * 2n,
  }));

test("a joiner takes the seat in the partner's lobby", async () => {
  const code = encodeShareCode(lobby(HOST_PK));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  const matchmaker = fakeMatchmaker([{ state: "waiting" }, { state: "join", code }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    expect.objectContaining({ covenantId: lobby(HOST_PK).covenantId }),
    expect.anything(),
    expect.any(Function),
  );
  expect(store.get(currentMatchAtom)?.state.p2).toBe(GUEST_PK);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("refuses a code off the Quick Match terms and queues again", async () => {
  const code = encodeShareCode(lobby(HOST_PK, 600));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  const matchmaker = fakeMatchmaker([{ state: "join", code }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).not.toHaveBeenCalled();
  expect(chain.ensureFunds).not.toHaveBeenCalled();
  expect(matchmaker.seek).toHaveBeenCalledTimes(2);
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
});

test("queues again when the seat is gone by the time we join", async () => {
  const code = encodeShareCode(lobby(HOST_PK));
  const chain = fakeChain({
    joinMatch: vi.fn(async () => {
      throw new Error("game UTXO not found");
    }),
  });
  const matchmaker = fakeMatchmaker([{ state: "join", code }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).toHaveBeenCalledTimes(1);
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
  expect(store.get(errorAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
});

test("cancels its lobby and queues again when the matchmaker drops it", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "gone" }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.cancelMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    expect.objectContaining({ covenantId: opened.covenantId }),
  );
  expect(store.get(matchesAtom)).toEqual([]);
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
});

test("stops with the error, lobby still on record, when the cancel fails", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({
    openMatch: vi.fn(async () => opened),
    cancelMatch: vi.fn(async () => {
      throw new Error("connection lost");
    }),
  });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "gone" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(matchmaker.seek).toHaveBeenCalledTimes(1);
  expect(store.get(errorAtom)).not.toBeNull();
  expect(store.get(matchesAtom).map((m) => m.covenantId)).toEqual([opened.covenantId]);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("shows the game when the partner's join beat our cancel", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({
    openMatch: vi.fn(async () => opened),
    cancelMatch: vi.fn(async () => {
      throw new Error("game UTXO not found");
    }),
  });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "gone" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(matchmaker.seek).toHaveBeenCalledTimes(1);
  expect(store.get(errorAtom)).toBeNull();
  expect(store.get(currentMatchAtom)?.covenantId).toBe(opened.covenantId);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("stopping leaves the queue and cancels a lobby nobody has taken", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "hosted" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(matchmaker.hosted).toHaveBeenCalled();
  await stopQuickMatch();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.cancelMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    expect.objectContaining({ covenantId: opened.covenantId }),
  );
  expect(store.get(matchesAtom)).toEqual([]);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
  const polls = vi.mocked(matchmaker.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(matchmaker.poll).toHaveBeenCalledTimes(polls);
});

test("says so and stops when the matchmaker can't be reached", async () => {
  const matchmaker = fakeMatchmaker([{ state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockRejectedValue(new TypeError("Failed to fetch"));
  deps = { chain: fakeChain(), account: fakeAccount(), matchmaker };
  await startQuickMatch(deps);
  expect(store.get(errorAtom)).toMatch(/Quick Match/);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("rides out a failed poll or two", async () => {
  const matchmaker = fakeMatchmaker([{ state: "waiting" }]);
  vi.mocked(matchmaker.poll)
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  deps = { chain: fakeChain(), account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.get(errorAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
  expect(vi.mocked(matchmaker.poll).mock.calls.length).toBeGreaterThan(3);
});

test("cancels the lobby and queues again when the matchmaker refuses it", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "waiting" }]);
  vi.mocked(matchmaker.hosted).mockResolvedValueOnce("refused");
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.cancelMatch).toHaveBeenCalledTimes(1);
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
});

test("gives up on a lobby the matchmaker never sees, and queues again", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "waiting" }]);
  vi.mocked(matchmaker.hosted).mockResolvedValue("retry");
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(chain.cancelMatch).toHaveBeenCalledTimes(1);
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
});

test("keeps polling while the host's lobby takes its time to open", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({
    openMatch: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 15_000));
      return opened;
    }),
  });
  const matchmaker = fakeMatchmaker([{ state: "host" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(1_000);
  const before = vi.mocked(matchmaker.poll).mock.calls.length;
  await vi.advanceTimersByTimeAsync(12_000);
  expect(matchmaker.hosted).not.toHaveBeenCalled();
  // The matchmaker drops a ticket after 10 s without a poll.
  expect(vi.mocked(matchmaker.poll).mock.calls.length - before).toBeGreaterThanOrEqual(5);
});

test("after the handover, the host opens the game once the join has landed", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "matched" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  // Matched, but the join isn't on record yet: no lobby screen in between.
  expect(store.get(currentMatchAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "setting-up" });
  // The off-screen watcher records the join.
  updateMatch({ ...opened, state: { ...opened.state, p2: HOST_PK }, value: FREE_STAKE * 2n });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(store.get(currentMatchAtom)?.state.p2).toBe(HOST_PK);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});
