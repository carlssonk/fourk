import { beforeEach, expect, test, vi } from "vitest";
import {
  HOST_GRACE_MS,
  MAX_TICKETS,
  POLL_GRACE_MS,
  REQUEST_LIMIT,
  SEEK_LIMIT,
  createMatchmaker,
} from "../sweeper/match";
import { MAX_BODY_BYTES } from "../sweeper/sweeper";
import * as engine from "../src/shared/lib/engine";
import { ZERO_PK } from "../src/shared/lib/game";
import { FREE_STAKE, NETWORK_ID, encodeShareCode, type Match } from "../src/shared/lib/match";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";

vi.mock("../src/shared/lib/engine", async (original) => ({
  ...(await original<typeof engine>()),
  fetchGameUtxo: vi.fn(),
}));

const rpc = {} as engine.Rpc;
let clock = 0;
const matchmaker = () => createMatchmaker(rpc, () => clock);
const alice = "11".repeat(32);
const bob = "22".repeat(32);
const carol = "33".repeat(32);

/** Join the queue and return the ticket. */
async function seek(mm: ReturnType<typeof matchmaker>, pk: string, client = pk): Promise<string> {
  const reply = await mm.seek(JSON.stringify({ pk }), client);
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body).ticket;
}

const poll = async (mm: ReturnType<typeof matchmaker>, ticket: string) => {
  const reply = await mm.poll(ticket, "x");
  return { status: reply.status, ...JSON.parse(reply.body || "{}") };
};

/** The Quick Match lobby `p1` opened, as its share code. */
const lobby = (p1: string, moveTimeout = 3_000): Match => ({
  network: NETWORK_ID,
  mode: "fourk2",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE,
  state: {
    p1,
    p2: ZERO_PK,
    board: new Uint8Array(42),
    moveCount: 0,
    stake: FREE_STAKE,
    moveTimeout,
    deadline: 900_000,
  },
  simul: zeroCore2(moveTimeout, 1),
});
const hosted = (ticket: string, m: Match) => JSON.stringify({ ticket, code: encodeShareCode(m) });

/** The chain's view of the lobby UTXO. */
const entry = { outpoint: { transactionId: "cd".repeat(32) }, amount: FREE_STAKE };

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  vi.mocked(engine.fetchGameUtxo).mockResolvedValue(entry as never);
});

test("pairs two seekers, and the one who waited longer hosts", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  expect(await poll(mm, a)).toMatchObject({ status: 200, state: "waiting" });
  clock += 1_000;
  const b = await seek(mm, bob);
  expect(await poll(mm, a)).toMatchObject({ status: 200, state: "host" });
  expect(await poll(mm, b)).toMatchObject({ status: 200, state: "waiting" });
});

test("never pairs a key with itself, as two tabs of one browser would", async () => {
  const mm = matchmaker();
  const a1 = await seek(mm, alice);
  const a2 = await seek(mm, alice);
  expect(await poll(mm, a1)).toMatchObject({ state: "waiting" });
  const b = await seek(mm, bob);
  expect(await poll(mm, a1)).toMatchObject({ state: "host" });
  expect(await poll(mm, a2)).toMatchObject({ state: "waiting" });
  expect(await poll(mm, b)).toMatchObject({ state: "waiting" });
});

test("drops a seeker who stopped polling instead of pairing with them", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  clock += POLL_GRACE_MS + 1;
  const b = await seek(mm, bob);
  const c = await seek(mm, carol);
  expect(await poll(mm, b)).toMatchObject({ state: "host" });
  expect(await poll(mm, c)).toMatchObject({ state: "waiting" });
  expect(await poll(mm, a)).toMatchObject({ status: 404, state: "gone" });
});

test("keeps a seeker who keeps polling", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  for (let i = 0; i < 5; i++) {
    clock += POLL_GRACE_MS - 1;
    expect(await poll(mm, a)).toMatchObject({ state: "waiting" });
  }
  await seek(mm, bob);
  expect(await poll(mm, a)).toMatchObject({ state: "host" });
});

test("forwards the host's code once the chain holds that lobby", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  const code = encodeShareCode(lobby(alice));
  vi.mocked(engine.fetchGameUtxo).mockResolvedValueOnce(null);
  // Not on chain yet (or not indexed on this node): the host retries.
  expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(404);
  expect(await poll(mm, b)).toMatchObject({ state: "waiting" });
  expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(202);
  expect(await poll(mm, b)).toMatchObject({ state: "join", code });
});

test("takes the lobby's value from the chain, not the code", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  vi.mocked(engine.fetchGameUtxo).mockResolvedValueOnce({
    ...entry,
    amount: FREE_STAKE * 2n,
  } as never);
  expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(404);
  expect(await poll(mm, b)).toMatchObject({ state: "waiting" });
});

test("refuses a code that isn't the paired host's Quick Match lobby", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  for (const [bad, status] of [
    ["not json", 400],
    [JSON.stringify({ ticket: a, code: "garbage" }), 400],
    [hosted("no-such-ticket", lobby(alice)), 404],
    // The partner can't host, nor post a lobby of their own.
    [hosted(b, lobby(bob)), 403],
    // Another player's lobby, or one on other terms.
    [hosted(a, lobby(carol)), 403],
    [hosted(a, lobby(alice, 600)), 400],
  ] as const)
    expect((await mm.hosted(bad, "x")).status, bad).toBe(status);
  expect(engine.fetchGameUtxo).not.toHaveBeenCalled();
  expect(await poll(mm, b)).toMatchObject({ state: "waiting" });
});

test("puts the partner back in the queue when the host leaves", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  clock += POLL_GRACE_MS - 1;
  expect(await poll(mm, b)).toMatchObject({ state: "waiting" });
  clock += 2;
  expect(await poll(mm, a)).toMatchObject({ status: 404, state: "gone" });
  await seek(mm, carol);
  expect(await poll(mm, b)).toMatchObject({ state: "host" });
});

test("drops a host who never posts a lobby, and requeues the partner", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  for (let waited = 0; waited <= HOST_GRACE_MS; waited += 5_000) {
    clock += 5_000;
    await poll(mm, a);
    await poll(mm, b);
  }
  expect(await poll(mm, a)).toMatchObject({ status: 404, state: "gone" });
  await seek(mm, carol);
  expect(await poll(mm, b)).toMatchObject({ state: "host" });
});

test("pairs a requeued partner with whoever is already waiting", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  const c = await seek(mm, carol);
  clock += POLL_GRACE_MS - 1;
  await poll(mm, b);
  await poll(mm, c);
  clock += 2;
  expect(await poll(mm, a)).toMatchObject({ state: "gone" });
  // Bob was queued before Carol, so Bob hosts.
  expect(await poll(mm, b)).toMatchObject({ state: "host" });
  expect(await poll(mm, c)).toMatchObject({ state: "waiting" });
  expect((await mm.hosted(hosted(b, lobby(bob)), "x")).status).toBe(202);
  expect(await poll(mm, c)).toMatchObject({ state: "join" });
});

test("ends the pair once the partner has the code", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  await mm.hosted(hosted(a, lobby(alice)), "x");
  expect(await poll(mm, a)).toMatchObject({ state: "hosted" });
  expect(await poll(mm, b)).toMatchObject({ state: "join" });
  expect(await poll(mm, a)).toMatchObject({ state: "matched" });
  // Bob is off joining and stops polling; Alice is not requeued for that.
  clock += POLL_GRACE_MS - 1;
  await poll(mm, a);
  clock += 2;
  expect(await poll(mm, a)).toMatchObject({ state: "matched" });
  const c = await seek(mm, carol);
  expect(await poll(mm, c)).toMatchObject({ state: "waiting" });
});

test("leaves the joiner out of the queue when the host stops polling first", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  await mm.hosted(hosted(a, lobby(alice)), "x");
  expect(await poll(mm, b)).toMatchObject({ state: "join" });
  expect(await poll(mm, a)).toMatchObject({ state: "matched" });
  // Alice is done; Bob is still taking the seat and keeps polling.
  clock += POLL_GRACE_MS - 1;
  await poll(mm, b);
  clock += 2;
  expect(await poll(mm, b)).toMatchObject({ state: "join" });
  const c = await seek(mm, carol);
  expect(await poll(mm, c)).toMatchObject({ state: "waiting" });
  expect(await poll(mm, b)).toMatchObject({ state: "join" });
});

test("hands a host's open lobby to the next seeker when the partner left first", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  await seek(mm, bob);
  await mm.hosted(hosted(a, lobby(alice)), "x");
  clock += POLL_GRACE_MS - 1;
  await poll(mm, a);
  clock += 2;
  // Bob never picked the code up; Alice's lobby stays up for someone else.
  expect(await poll(mm, a)).toMatchObject({ state: "hosted" });
  const c = await seek(mm, carol);
  expect(await poll(mm, c)).toMatchObject({ state: "join", code: encodeShareCode(lobby(alice)) });
  expect(engine.fetchGameUtxo).toHaveBeenCalledTimes(1);
});

test("refuses a seek without a well-formed key, or past the size and queue caps", async () => {
  const mm = matchmaker();
  for (const bad of ["not json", "[]", JSON.stringify({ pk: "zz" }), JSON.stringify({ pk: 7 })])
    expect((await mm.seek(bad, "a")).status, bad).toBe(400);
  expect((await mm.seek("x".repeat(MAX_BODY_BYTES + 1), "a")).status).toBe(413);
  expect((await mm.hosted("x".repeat(MAX_BODY_BYTES + 1), "a")).status).toBe(413);
  // Distinct clients and keys, so only the queue cap is in the way.
  const key = (i: number) => i.toString(16).padStart(64, "0");
  for (let i = 0; i < MAX_TICKETS; i++)
    expect((await mm.seek(JSON.stringify({ pk: key(i) }), `c${i}`)).status).toBe(200);
  expect((await mm.seek(JSON.stringify({ pk: key(MAX_TICKETS) }), "late")).status).toBe(503);
});

test("limits each client's seeks tightly and its requests loosely", async () => {
  const mm = matchmaker();
  const t = await seek(mm, alice, "a");
  for (let i = 1; i < SEEK_LIMIT; i++) await seek(mm, alice, "a");
  expect((await mm.seek(JSON.stringify({ pk: alice }), "a")).status).toBe(429);
  expect((await mm.seek(JSON.stringify({ pk: bob }), "b")).status).toBe(200);
  for (let i = SEEK_LIMIT + 1; i < REQUEST_LIMIT; i++) await mm.poll(t, "a");
  expect((await mm.poll(t, "a")).status).toBe(429);
  expect((await mm.poll(t, "b")).status).toBe(200);
  clock += 60_000;
  expect((await mm.seek(JSON.stringify({ pk: alice }), "a")).status).toBe(200);
});

test("keeps a host who is still posting a lobby the node hasn't indexed", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  const b = await seek(mm, bob);
  vi.mocked(engine.fetchGameUtxo).mockResolvedValue(null);
  for (let i = 0; i < 6; i++) {
    clock += 2_000;
    expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(404);
    await poll(mm, b);
  }
  vi.mocked(engine.fetchGameUtxo).mockResolvedValue(entry as never);
  expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(202);
  expect(await poll(mm, b)).toMatchObject({ state: "join" });
});

test("a host whose partner left mid-open keeps hosting for the next seeker", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  await seek(mm, bob);
  clock += POLL_GRACE_MS - 1;
  await poll(mm, a); // Alice's heartbeat while her lobby opens
  clock += 2; // Bob has gone quiet
  expect(await poll(mm, a)).toMatchObject({ state: "host" });
  const c = await seek(mm, carol);
  expect((await mm.hosted(hosted(a, lobby(alice)), "x")).status).toBe(202);
  expect(await poll(mm, c)).toMatchObject({ state: "join", code: encodeShareCode(lobby(alice)) });
});

test("a host who keeps getting new partners still has to post within the grace", async () => {
  const mm = matchmaker();
  const a = await seek(mm, alice);
  await seek(mm, bob);
  for (let waited = 0; waited <= HOST_GRACE_MS; waited += 5_000) {
    clock += 5_000;
    await poll(mm, a);
    await seek(mm, (waited / 5_000 + 0x40).toString(16).padStart(64, "0"));
  }
  expect(await poll(mm, a)).toMatchObject({ state: "gone" });
});
