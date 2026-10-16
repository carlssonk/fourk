/**
 * The Quick Match loop (docs/adr/0003) through the Deps seam: a scripted
 * matchmaker beside the in-memory chain and account fakes. No node, no
 * network; timers are faked so the poll loop runs on demand.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { busyAtom, connectingAtom, errorAtom } from "../src/shared/state/actions";
import {
  currentMatchAtom,
  matchesAtom,
  pendingInviteAtom,
  updateMatch,
} from "../src/shared/state/matches";
import { quickMatchAtom, startQuickMatch, stopQuickMatch } from "../src/shared/state/quickMatch";
import { gameModeAtom } from "../src/shared/state/profile";
import { SEEK_LIMITED } from "../src/shared/lib/matchmaker";
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
const lobby = (p1: string, moveTimeout = 1_200): Match => ({
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
  simul: zeroCore2(moveTimeout, 1),
});
/** The same lobby in Classic, which has no round machine. */
const classicLobby = (p1: string): Match => ({ ...lobby(p1), mode: undefined, simul: undefined });

let deps: QuickMatchDeps;

beforeEach(() => {
  bag.clear();
  vi.useFakeTimers();
  store.set(matchesAtom, []);
  store.set(currentMatchAtom, null);
  store.set(errorAtom, null);
  store.set(busyAtom, false);
  store.set(pendingInviteAtom, null);
  store.set(gameModeAtom, "fourk2");
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
  expect(matchmaker.seek).toHaveBeenCalledWith(GUEST_PK, "fourk2");
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
    expect.objectContaining({ moveTimeout: 1_200 }),
    "fourk2",
    expect.any(Function),
    { quick: true },
  );
  // On record (a reload must find it), but not on screen yet.
  expect(store.get(matchesAtom).map((m) => m.covenantId)).toEqual([opened.covenantId]);
  expect(store.get(currentMatchAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "setting-up" });
  await vi.advanceTimersByTimeAsync(10_000);
  // Posted again after the matchmaker's node hadn't seen it yet.
  expect(matchmaker.hosted).toHaveBeenCalledTimes(2);
  expect(vi.mocked(matchmaker.hosted).mock.calls[1]).toEqual(["t1", expect.any(String)]);
  // No join on record within the wait: the partner took the code and left.
  // Close the empty lobby and look again, rather than opening it.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(chain.cancelMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    expect.objectContaining({ covenantId: opened.covenantId }),
  );
  expect(store.get(currentMatchAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
  expect(matchmaker.seek).toHaveBeenCalledTimes(2);
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

test("a host opens its lobby as a Quick Match in covenant state", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  deps = { chain, account: fakeAccount(), matchmaker: fakeMatchmaker([{ state: "host" }]) };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(chain.openMatch).toHaveBeenCalledWith(
    expect.anything(),
    FREE_STAKE,
    expect.anything(),
    "fourk2",
    expect.any(Function),
    { quick: true },
  );
});

test("a joiner holds the lobby's game limit to the Quick Match cap, both ways", async () => {
  const code = encodeShareCode(lobby(HOST_PK));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  deps = { chain, account: fakeAccount(), matchmaker: fakeMatchmaker([{ state: "join", code }]) };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  // The preset opens with ~1 day (864,000 DAA); an hour of slack for the
  // seconds between the host's open and this join.
  expect(chain.assertJoinableDeadline).toHaveBeenCalledWith(
    expect.objectContaining({ covenantId: lobby(HOST_PK).covenantId }),
    { min: 864_000 - 36_000, max: 864_000 + 36_000 },
  );
});

test("queues again, quietly, past a lobby whose game limit is cut short", async () => {
  const code = encodeShareCode(lobby(HOST_PK));
  const chain = fakeChain({
    joinMatch: joinedBy(GUEST_PK),
    assertJoinableDeadline: vi.fn(async () => {
      throw new Error("DEADLINE_TOO_CLOSE");
    }),
  });
  const matchmaker = fakeMatchmaker([{ state: "join", code }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).not.toHaveBeenCalled();
  expect(store.get(errorAtom)).toBeNull();
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
});

test("a host whose partner left goes back to looking, keeping its lobby for the next one", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([
    { state: "host" },
    { state: "hosted" },
    { state: "open" },
    { state: "open" },
    { state: "hosted" },
  ]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "setting-up" });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
  expect(chain.cancelMatch).not.toHaveBeenCalled();
  expect(chain.openMatch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "setting-up" });
});

test("says to wait a moment, not that Quick Match is down, when searches are rate-limited", async () => {
  const matchmaker = fakeMatchmaker([{ state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockRejectedValue(new Error(SEEK_LIMITED));
  deps = { chain: fakeChain(), account: fakeAccount(), matchmaker };
  await startQuickMatch(deps);
  expect(store.get(errorAtom)).toMatch(/try again in a minute/i);
  expect(store.get(errorAtom)).not.toMatch(/isn't available/);
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("the connecting journey says an opponent was found, and never mentions an invite link", async () => {
  const seen: Array<{ title: string; steps: readonly string[] } | null> = [];
  const opened = lobby(GUEST_PK);
  const host = fakeChain({
    openMatch: vi.fn(async () => {
      seen.push(store.get(connectingAtom));
      return opened;
    }),
  });
  deps = { chain: host, account: fakeAccount(), matchmaker: fakeMatchmaker([{ state: "host" }]) };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);
  await stopQuickMatch();

  const code = encodeShareCode(lobby(HOST_PK));
  const joiner = fakeChain({
    joinMatch: vi.fn(async (_key: PrivateKey, invite: Match) => {
      seen.push(store.get(connectingAtom));
      return { ...invite, state: { ...invite.state, p2: GUEST_PK }, value: FREE_STAKE * 2n };
    }),
  });
  deps = {
    chain: joiner,
    account: fakeAccount(),
    matchmaker: fakeMatchmaker([{ state: "join", code }]),
  };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);

  expect(seen).toHaveLength(2);
  for (const journey of seen) {
    expect(journey?.title).toBe("Found an opponent");
    expect(journey?.steps.join(" ")).not.toMatch(/invite|link/i);
  }
  expect(seen[0]?.steps[2]).toBe("Creating the game");
  expect(seen[1]?.steps.at(-1)).toBe("Joining the game");
});

test("the host stays on one Found an opponent screen from creating the game to the board", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([
    { state: "host" },
    { state: "hosted" },
    { state: "open" },
    { state: "hosted" },
    { state: "matched" },
  ]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(1_000);
  // Created: the same screen moves on to its last step, with a way out.
  expect(store.get(connectingAtom)).toMatchObject({
    title: "Found an opponent",
    step: 3,
    steps: [
      "Connecting to the game",
      "Preparing your seat",
      "Creating the game",
      "Waiting for your opponent to join",
    ],
  });
  expect(store.get(connectingAtom)?.cancel).toBeTypeOf("function");
  // The partner left: back to looking, the screen gone.
  await vi.advanceTimersByTimeAsync(4_000);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
  expect(store.get(connectingAtom)).toBeNull();
  // A new partner: the waiting screen again.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(store.get(connectingAtom)).toMatchObject({ title: "Found an opponent", step: 3 });
  // Their join lands: the board, and no screen left over.
  updateMatch({ ...opened, state: { ...opened.state, p2: HOST_PK }, value: FREE_STAKE * 2n });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(store.get(currentMatchAtom)?.state.p2).toBe(HOST_PK);
  expect(store.get(connectingAtom)).toBeNull();
});

test("Cancel on the waiting screen leaves the queue and closes the lobby", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  deps = {
    chain,
    account: fakeAccount(),
    matchmaker: fakeMatchmaker([{ state: "host" }, { state: "hosted" }]),
  };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);
  store.get(connectingAtom)!.cancel!();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(chain.cancelMatch).toHaveBeenCalledTimes(1);
  expect(store.get(connectingAtom)).toBeNull();
  expect(store.get(quickMatchAtom)).toEqual({ phase: "idle" });
});

test("the host's Found an opponent screen never drops out between creating and waiting", async () => {
  const opened = lobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "hosted" }]);
  // The matchmaker's node is a moment behind: the post needs a retry.
  vi.mocked(matchmaker.hosted).mockResolvedValueOnce("retry");
  const screens: Array<number | null> = [];
  const unsub = store.sub(connectingAtom, () =>
    screens.push(store.get(connectingAtom)?.step ?? null),
  );
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(6_000);
  unsub();
  const first = screens.indexOf(0);
  const waiting = screens.indexOf(3);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(waiting).toBeGreaterThan(first);
  expect(screens.slice(first, waiting + 1)).not.toContain(null);
});

test("queues and hosts in the picked mode, the game marked paired", async () => {
  store.set(gameModeAtom, "classic");
  const opened = classicLobby(GUEST_PK);
  const chain = fakeChain({ openMatch: vi.fn(async () => opened) });
  const matchmaker = fakeMatchmaker([{ state: "host" }, { state: "hosted" }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(matchmaker.seek).toHaveBeenCalledWith(GUEST_PK, "classic");
  expect(chain.openMatch).toHaveBeenCalledWith(
    keyOf("guest"),
    FREE_STAKE,
    expect.objectContaining({ moveTimeout: 1_200 }),
    "classic",
    expect.any(Function),
    { quick: true },
  );
  // Classic's covenant can't say so, so the record does: the in-game exit
  // reads it to offer Leave game, not Kick opponent.
  expect(store.get(matchesAtom)[0]).toMatchObject({ covenantId: opened.covenantId, paired: true });
});

test("a joiner refuses a lobby in another mode than it queued for", async () => {
  const code = encodeShareCode(lobby(HOST_PK));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  const matchmaker = fakeMatchmaker([{ state: "join", code }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  store.set(gameModeAtom, "classic");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).not.toHaveBeenCalled();
  expect(matchmaker.seek).toHaveBeenCalledTimes(2);
});

test("a Classic joiner takes the seat, the game marked paired", async () => {
  store.set(gameModeAtom, "classic");
  const code = encodeShareCode(classicLobby(HOST_PK));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  const matchmaker = fakeMatchmaker([{ state: "join", code }]);
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(store.get(currentMatchAtom)).toMatchObject({
    paired: true,
    state: { p2: GUEST_PK },
  });
});

test("a joiner handed its own lobby skips it and queues again", async () => {
  // An honest matchmaker never pairs a key with itself; the joiner doesn't
  // rely on that.
  const code = encodeShareCode(lobby(GUEST_PK));
  const chain = fakeChain({ joinMatch: joinedBy(GUEST_PK) });
  const matchmaker = fakeMatchmaker([{ state: "join", code }, { state: "waiting" }]);
  vi.mocked(matchmaker.seek).mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
  deps = { chain, account: fakeAccount(), matchmaker };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(chain.joinMatch).not.toHaveBeenCalled();
  expect(store.get(currentMatchAtom)).toBeNull();
  expect(matchmaker.poll).toHaveBeenLastCalledWith("t2");
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching" });
});

test("the search remembers its mode, whatever the picker says meanwhile", async () => {
  store.set(gameModeAtom, "classic");
  deps = {
    chain: fakeChain(),
    account: fakeAccount(),
    matchmaker: fakeMatchmaker([{ state: "waiting" }]),
  };
  void startQuickMatch(deps);
  await vi.advanceTimersByTimeAsync(1_000);
  // Changed in another tab: this search is still Classic's.
  store.set(gameModeAtom, "fourk2");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(store.get(quickMatchAtom)).toMatchObject({ phase: "searching", mode: "classic" });
});
