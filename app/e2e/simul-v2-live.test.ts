/**
 * Live end-to-end run of Fourk V2 (shared picking deadlines) against a LOCAL
 * simnet node (localnet/run-node.sh + mine.mjs), driving the app's real
 * transaction engine for both players from one process. This is the
 * acceptance-timing and transaction-race verification the design doc lists
 * as a rollout gate: picks are timely by their acceptance score, the first
 * pick of a game starts the other player's window and a stalled first round
 * is refunded rather than forfeited, a late second pick in a later round
 * pays the first committer, a late first pick draws, the rebase grace holds,
 * the lobby exits close at the first pick, and a stale client re-derives an
 * opponent's commit from the virtual chain when it never saw the spent
 * output alive.
 *
 * Opt-in: SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run app/e2e/simul-v2-live.test.ts
 * (from the repo root; the miner must be running or nothing confirms).
 */

import fs from "node:fs";
import { describe, expect, test } from "vitest";

const LIVE = process.env.SIMNET_E2E === "1";

const bags = [new Map<string, string>(), new Map<string, string>()];
let bag = bags[0]!;
(globalThis as any).localStorage ??= {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
};
async function as1<T>(fn: () => Promise<T>): Promise<T> {
  bag = bags[0]!;
  return await fn();
}
async function as2<T>(fn: () => Promise<T>): Promise<T> {
  bag = bags[1]!;
  try {
    return await fn();
  } finally {
    bag = bags[0]!;
  }
}

import kaspaInit, * as kaspa from "kaspa-wasm";
import fourkInit from "fourk-wasm";
import * as cov from "../src/shared/lib/covenant";
import * as engine from "../src/shared/lib/engine";
import {
  claimTimeoutMatch,
  claimWinMatch,
  commitMatch,
  revealMatch,
  splitTimeoutMatch,
  sweepWinMatch,
} from "../src/shared/modes/fourk2/actions";
import { core2Of, type SimulCore2 } from "../src/shared/modes/fourk2/core";
import { fourk2Mode } from "../src/shared/modes/fourk2";
import { REBASE_GRACE_DAA } from "../../src/simul-v2/rules";
import type { Match } from "../src/shared/lib/match";
import { decodeShareCode, encodeShareCode, matchToJson } from "../src/shared/lib/match";
import { createSweeper } from "../sweeper/sweeper";
import { cellIndex } from "../src/shared/lib/game";
import { roundPhase, toSimulState } from "../src/shared/modes/fourk/core";

const NODE_URL = "ws://127.0.0.1:17510";
const MAX_FEE = 2_000_000n;
const NETWORK_TYPE = "simnet";
const KAS = 100_000_000n;
const FAUCET_KEY_FILE = new URL("../../faucet/faucet.key", import.meta.url);
const KASPA_WASM = new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url);
const FOURK_WASM = new URL("../../wasm/pkg/fourk_wasm_bg.wasm", import.meta.url);

/** Submit-to-acceptance latency samples (DAA), printed at the end: the
 * number that calibrates the UI margin and the rebase grace. */
const latency: number[] = [];

async function setup() {
  await kaspaInit(fs.readFileSync(KASPA_WASM));
  await fourkInit(fs.readFileSync(FOURK_WASM));
  const rpc = await cov.connect(NODE_URL);
  const faucet = new kaspa.PrivateKey(fs.readFileSync(FAUCET_KEY_FILE, "utf8").trim());
  // Fresh keys per test: a stale UTXO set from a previous test cannot leak in.
  const p1 = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey);
  const p2 = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey);
  await fundFromFaucet(
    rpc,
    faucet,
    [p1, p2].map((k) => [k.toAddress(NETWORK_TYPE).toString(), 20n * KAS]),
  );
  for (let i = 0; i < 60; i++) {
    const bal = await cov.walletBalance(rpc, cov.walletAddress(p2));
    if (bal >= 20n * KAS) break;
    await sleep(500);
  }
  return { rpc, p1, p2, faucet };
}

async function fundFromFaucet(
  rpc: cov.Rpc,
  faucet: kaspa.PrivateKey,
  outputs: Array<[address: string, amount: bigint]>,
) {
  const from = faucet.toAddress(NETWORK_TYPE).toString();
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const { virtualDaaScore } = await rpc.getBlockDagInfo();
  const spendable = (entries as any[]).filter((e) => {
    if (!(e.isCoinbase ?? e.entry?.isCoinbase)) return true;
    const born = BigInt(e.blockDaaScore ?? e.entry?.blockDaaScore ?? 0n);
    return BigInt(virtualDaaScore) - born >= 1000n;
  });
  const { transactions } = await kaspa.createTransactions({
    entries: spendable,
    outputs: outputs.map(([address, amount]) => ({ address, amount })),
    changeAddress: from,
    priorityFee: 5_000_000n,
    networkId: "simnet",
  });
  for (const pending of transactions) {
    await pending.sign([faucet]);
    await pending.submit(rpc);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function core(m: Match): SimulCore2 {
  return core2Of(m);
}

function phase(m: Match) {
  return roundPhase(toSimulState(m.state, core(m)));
}

async function daaNow(rpc: cov.Rpc): Promise<number> {
  const info: any = await rpc.getBlockDagInfo();
  return Number(info.virtualDaaScore);
}

/** Block until the chain's DAA score reaches `target` (~10 blocks/s). */
async function untilDaa(rpc: cov.Rpc, target: number) {
  for (let i = 0; i < 1200; i++) {
    if ((await daaNow(rpc)) >= target) return;
    await sleep(250);
  }
  throw new Error(`chain never reached DAA ${target}`);
}

/** Block until the game UTXO's age reaches `age`. */
async function untilAge(rpc: cov.Rpc, m: Match, age: number) {
  for (let i = 0; i < 1200; i++) {
    const now = await cov.gameUtxoAge(rpc, m);
    if (now !== null && now >= age) return;
    await sleep(250);
  }
  throw new Error(`game UTXO never aged to ${age}`);
}

async function waitGone(rpc: cov.Rpc, m: Match) {
  for (let i = 0; i < 120; i++) {
    const { status } = await cov.syncMatch(rpc, m);
    if (status === "terminated") return;
    await sleep(500);
  }
  throw new Error("terminal spend never confirmed");
}

async function balanceAbove(rpc: cov.Rpc, key: kaspa.PrivateKey, before: bigint): Promise<bigint> {
  let after = before;
  for (let i = 0; i < 60 && after <= before; i++) {
    await sleep(500);
    after = await cov.walletBalance(rpc, cov.walletAddress(key));
  }
  return after;
}

function expectPinnedHalf(after: bigint, before: bigint) {
  expect(after).toBeGreaterThanOrEqual(before + 1n * KAS - MAX_FEE / 2n);
  expect(after).toBeLessThan(before + 1n * KAS);
}

/** A transition with its submit-time chain score recorded against the
 * acceptance score the successor was observed with. */
async function timed<T extends Match>(rpc: cov.Rpc, submit: () => Promise<T>): Promise<T> {
  const before = await daaNow(rpc);
  const m = await submit();
  if (m.acceptedDaa !== undefined) latency.push(m.acceptedDaa - before);
  return m;
}

async function openAndJoin(
  rpc: cov.Rpc,
  p1: kaspa.PrivateKey,
  p2: kaspa.PrivateKey,
  moveTimeout: number,
  quick = false,
) {
  const timing = { moveTimeout, totalCap: 864_000 };
  let m = await cov.openMatch(rpc, p1, 1n * KAS, timing, "fourk2", undefined, { quick });
  expect(m.mode).toBe("fourk2");
  expect(core(m).revealTimeout).toBe(moveTimeout);
  expect(core(m).quick).toBe(quick ? 1 : 0);
  m = await cov.joinMatch(rpc, p2, m);
  expect(m.value).toBe(2n * KAS);
  expect(core(m).pickDeadline).toBe(0);
  expect(core(m).firstCommitter).toBe(0);
  return m;
}

/** The first round played through from the joined lobby: p1's pick starts
 * p2's window (measured from p1's pick, exactly), both reveal, and the
 * resolve output — the second round's start — comes back stamped. */
async function playFirstRound(
  rpc: cov.Rpc,
  p1: kaspa.PrivateKey,
  p2: kaspa.PrivateKey,
  m: Match,
  colP1: number,
  colP2: number,
) {
  const one = await as1(() => timed(rpc, () => commitMatch(rpc, p1, m, colP1)));
  expect(core(one).pickDeadline).toBe(0);
  expect(core(one).firstCommitter).toBe(1);
  expect(one.acceptedDaa).toBeDefined();
  const two = await as2(() => timed(rpc, () => commitMatch(rpc, p2, one, colP2)));
  expect(core(two).pickDeadline).toBe(one.acceptedDaa! + m.state.moveTimeout);
  expect(phase(two)).toBe("reveal");
  const shown = await as1(() => timed(rpc, () => revealMatch(rpc, p1, two)));
  expect(phase(shown)).toBe("resolve");
  expect(core(shown).pickDeadline).toBe(0);
  const next = await as2(() => timed(rpc, () => revealMatch(rpc, p2, shown)));
  expect(core(next).round).toBe(1);
  expect(next.acceptedDaa).toBeDefined();
  return next;
}

(LIVE ? describe : describe.skip)("fourk V2 on a live simnet chain", () => {
  test("a full V2 game: the first pick starts it, shared cutoffs, rounds, claim_win, sweep", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await openAndJoin(rpc, p1, p2, 600);
    const decoded = decodeShareCode(encodeShareCode(m));
    expect(decoded.mode).toBe("fourk2");
    expect(decoded.simul).toEqual(core(m));
    // Both players may pick straight from the lobby.
    expect(cov.isActionable(m, cov.walletPubkey(p1))).toBe(true);
    expect(cov.isActionable(m, cov.walletPubkey(p2))).toBe(true);

    // Round 0: a collision; the first pick closes the lobby.
    m = await playFirstRound(rpc, p1, p2, m, 3, 3);
    expect(m.state.board[cellIndex(3, 0)]).toBe(1);
    expect(m.state.board[cellIndex(3, 1)]).toBe(2);

    // Round 1: the first commit's cutoff is the round-start output's
    // acceptance plus the picking window — exactly.
    const start = m.acceptedDaa!;
    m = await as2(() => timed(rpc, () => commitMatch(rpc, p2, m, 0)));
    expect(core(m).pickDeadline).toBe(start + 600);
    expect(core(m).firstCommitter).toBe(2);
    expect(cov.isActionable(m, cov.walletPubkey(p2))).toBe(false);
    expect(cov.isActionable(m, cov.walletPubkey(p1))).toBe(true);
    const firstAccepted = m.acceptedDaa!;
    m = await as1(() => timed(rpc, () => commitMatch(rpc, p1, m, 4)));
    // The second commit stores the graced cutoff, unchanged here because
    // the first commit landed well inside the window.
    expect(core(m).pickDeadline).toBe(Math.max(start + 600, firstAccepted + REBASE_GRACE_DAA));
    expect(phase(m)).toBe("reveal");
    m = await as2(() => timed(rpc, () => revealMatch(rpc, p2, m)));
    expect(core(m).pickDeadline).toBe(0);
    m = await as1(() => timed(rpc, () => revealMatch(rpc, p1, m)));
    expect(core(m).round).toBe(2);

    // Rounds 2-4: p1 lays row 0 across 5,6 then 2 (with (3,0),(4,0) already
    // theirs); p2 stacks column 0 — either commit order works.
    for (const [colP1, colP2] of [
      [5, 0],
      [6, 0],
      [2, 1],
    ] as const) {
      m = await as2(() => timed(rpc, () => commitMatch(rpc, p2, m, colP2)));
      expect(core(m).firstCommitter).toBe(2);
      m = await as1(() => timed(rpc, () => commitMatch(rpc, p1, m, colP1)));
      m = await as2(() => timed(rpc, () => revealMatch(rpc, p2, m)));
      m = await as1(() => timed(rpc, () => revealMatch(rpc, p1, m)));
    }
    expect(core(m).round).toBe(5);
    for (const c of [3, 4, 5, 6]) expect(m.state.board[cellIndex(c, 0)]).toBe(1);

    // The line is claimed on the current board; the claim opens the
    // challenge window (the reveal grace), then anyone sweeps: here the
    // payout service (app/sweeper), keyless, as if both players had left.
    const before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    m = await as1(() => claimWinMatch(rpc, p1, m, { col: 3, row: 0, dir: 0 }));
    expect(core(m).pendingWin).toBe(1);
    await expect(sweepWinMatch(rpc, m)).rejects.toThrow();
    const sweeper = createSweeper(rpc);
    expect(await sweeper.intake(matchToJson(m), "test")).toEqual({ status: 202, body: "queued" });
    await untilAge(rpc, m, 600);
    await sweeper.tick();
    expect(sweeper.size()).toBe(0);
    await waitGone(rpc, m);
    const after = await balanceAbove(rpc, p1, before);
    expect(after).toBeGreaterThan(before + 2n * KAS - KAS / 10n);
    // The calibration number for the UI margin and the rebase grace.
    const report = `submit-to-acceptance latency (DAA): ${latency.join(" ")}`;
    console.log(report);
    if (process.env.V2_LATENCY_OUT) fs.writeFileSync(process.env.V2_LATENCY_OUT, report + "\n");
  }, 600_000);

  test("a second pick accepted after the cutoff: refunded in the first round, the first committer's win later", async () => {
    const { rpc, p1, p2 } = await setup();
    // The first round: p1 picks, p2's window runs from that pick and p2
    // misses it. The commit is accepted (its own transaction cannot know it
    // is late), nobody can reveal on it, and nobody can claim: the game is
    // called off and both stakes come back.
    let m = await openAndJoin(rpc, p1, p2, 600);
    const lone = await as1(() => commitMatch(rpc, p1, m, 0));
    await expect(as1(() => claimTimeoutMatch(rpc, p1, lone))).rejects.toThrow(/first round/);
    await untilDaa(rpc, lone.acceptedDaa! + 600 + 20);
    const lateFirst = await as2(() => commitMatch(rpc, p2, lone, 1));
    expect(phase(lateFirst)).toBe("reveal");
    expect(lateFirst.acceptedDaa!).toBeGreaterThan(core(lateFirst).pickDeadline);
    await expect(as2(() => revealMatch(rpc, p2, lateFirst))).rejects.toThrow(/late/);
    await expect(as1(() => revealMatch(rpc, p1, lateFirst))).rejects.toThrow(/late/);
    await expect(as1(() => claimTimeoutMatch(rpc, p1, lateFirst))).rejects.toThrow(/first round/);
    await expect(as2(() => claimTimeoutMatch(rpc, p2, lateFirst))).rejects.toThrow();
    const view = fourk2Mode.view(lateFirst, {
      myPk: cov.walletPubkey(p1),
      role: "p1",
      clockExpired: false,
      busy: false,
      pendingCol: null,
      result: null,
    });
    expect(view.canClaimTimeout).toBe(false);
    expect(view.status.segments[1]!.text).toMatch(/called off/);
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await splitTimeoutMatch(rpc, p2, lateFirst);
    await waitGone(rpc, lateFirst);
    expectPinnedHalf(await balanceAbove(rpc, p2, p2Before), p2Before);

    // From the second round on the same lateness is the first committer's win.
    m = await openAndJoin(rpc, p1, p2, 600);
    m = await playFirstRound(rpc, p1, p2, m, 3, 4);
    const one = await as1(() => commitMatch(rpc, p1, m, 0));
    const cutoff = core(one).pickDeadline;
    expect(cutoff).toBe(m.acceptedDaa! + 600);
    // Too early: the claim's lock time is the cutoff (or the rebase grace).
    await expect(as1(() => claimTimeoutMatch(rpc, p1, one))).rejects.toThrow(/not reached/);
    await untilDaa(rpc, Math.max(cutoff, one.acceptedDaa! + REBASE_GRACE_DAA) + 20);
    const two = await as2(() => commitMatch(rpc, p2, one, 1));
    expect(phase(two)).toBe("reveal");
    expect(two.acceptedDaa!).toBeGreaterThan(core(two).pickDeadline);
    await expect(as2(() => revealMatch(rpc, p2, two))).rejects.toThrow(/late/);
    await expect(as1(() => revealMatch(rpc, p1, two))).rejects.toThrow(/late/);
    await expect(as2(() => claimTimeoutMatch(rpc, p2, two))).rejects.toThrow();
    await expect(splitTimeoutMatch(rpc, p2, two)).rejects.toThrow();
    const before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await as1(() => claimTimeoutMatch(rpc, p1, two));
    await waitGone(rpc, two);
    const after = await balanceAbove(rpc, p1, before);
    expect(after).toBeGreaterThan(before + 2n * KAS - KAS / 10n);
    // The view reads the same verdict off the stamp.
    expect(
      fourk2Mode.view(two, {
        myPk: cov.walletPubkey(p1),
        role: "p1",
        clockExpired: false,
        busy: false,
        pendingCol: null,
        result: null,
      }).canClaimTimeout,
    ).toBe(true);
  }, 900_000);

  test("a first pick accepted after the cutoff draws; no picks at all split after the window", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await openAndJoin(rpc, p1, p2, 600);
    m = await playFirstRound(rpc, p1, p2, m, 3, 4);
    // Before the window ends nobody can split.
    await expect(splitTimeoutMatch(rpc, p2, m)).rejects.toThrow(/not reached/);
    await untilDaa(rpc, m.acceptedDaa! + 600 + 20);
    // A first commit that lands after the window is accepted but decides
    // nothing but a draw: no timeout claim, a permissionless split.
    const late = await as1(() => commitMatch(rpc, p1, m, 0));
    expect(late.acceptedDaa!).toBeGreaterThan(core(late).pickDeadline);
    await expect(as2(() => commitMatch(rpc, p2, late, 1))).rejects.toThrow(/late/);
    await expect(as1(() => claimTimeoutMatch(rpc, p1, late))).rejects.toThrow();
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await splitTimeoutMatch(rpc, p2, late);
    await waitGone(rpc, late);
    expectPinnedHalf(await balanceAbove(rpc, p2, p2Before), p2Before);

    // And a round nobody picks in: the split waits for the window, then pays.
    let n = await openAndJoin(rpc, p1, p2, 600);
    n = await playFirstRound(rpc, p1, p2, n, 3, 4);
    await untilDaa(rpc, n.acceptedDaa! + 600 + 20);
    const p1Before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await splitTimeoutMatch(rpc, p1, n);
    await waitGone(rpc, n);
    expectPinnedHalf(await balanceAbove(rpc, p1, p1Before), p1Before);
  }, 900_000);

  test("rebase grace: a second pick rebuilt after a last-moment first pick still counts", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await openAndJoin(rpc, p1, p2, 1200);
    m = await playFirstRound(rpc, p1, p2, m, 3, 4);
    const start = m.acceptedDaa!;
    const cutoff = start + 1200;
    // p1 picks with ~5 s of the window left.
    await untilDaa(rpc, cutoff - 50);
    const one = await as1(() => commitMatch(rpc, p1, m, 0));
    expect(one.acceptedDaa!).toBeLessThanOrEqual(cutoff);
    const graced = Math.max(cutoff, one.acceptedDaa! + REBASE_GRACE_DAA);
    expect(graced).toBeGreaterThan(cutoff);
    // p2's rebuilt pick lands after the cutoff but inside the grace.
    await untilDaa(rpc, cutoff + 10);
    const two = await as2(() => commitMatch(rpc, p2, one, 1));
    expect(core(two).pickDeadline).toBe(graced);
    expect(two.acceptedDaa!).toBeGreaterThan(cutoff);
    expect(two.acceptedDaa!).toBeLessThanOrEqual(graced);
    // Timely: no claim for the first committer, and the round proceeds.
    await expect(as1(() => claimTimeoutMatch(rpc, p1, two))).rejects.toThrow();
    let next = await as2(() => revealMatch(rpc, p2, two));
    expect(phase(next)).toBe("resolve");
    next = await as1(() => revealMatch(rpc, p1, next));
    expect(core(next).round).toBe(2);
    expect(next.state.board[cellIndex(0, 0)]).toBe(1);
    expect(next.state.board[cellIndex(1, 0)]).toBe(2);
  }, 900_000);

  test("lobby exits close at the first pick; an unanswered first pick is refunded, never forfeited", async () => {
    const { rpc, p1, p2 } = await setup();
    // The host can kick a joined lobby; the seat is refunded.
    let m = await openAndJoin(rpc, p1, p2, 600);
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await cov.dissolveMatch(rpc, p1, m);
    await waitGone(rpc, m);
    expectPinnedHalf(await balanceAbove(rpc, p2, p2Before), p2Before);

    // The joiner's first pick closes the lobby: neither exit works any more,
    // and neither does a claim — the pick's own window runs, then the split.
    const n = await openAndJoin(rpc, p1, p2, 600);
    const lone = await as2(() => commitMatch(rpc, p2, n, 0));
    expect(core(lone).pickDeadline).toBe(0);
    expect(core(lone).firstCommitter).toBe(2);
    await expect(cov.dissolveMatch(rpc, p1, lone)).rejects.toThrow();
    await expect(cov.dissolveMatch(rpc, p2, lone)).rejects.toThrow();
    await expect(as2(() => claimTimeoutMatch(rpc, p2, lone))).rejects.toThrow(/first round/);
    await expect(splitTimeoutMatch(rpc, p1, lone)).rejects.toThrow(/not reached/);
    // The seat clock the host would see: the pick's acceptance plus the window.
    expect(fourk2Mode.clock(lone)).toEqual({
      kind: "absolute",
      daa: lone.acceptedDaa! + 600,
    });
    await untilDaa(rpc, lone.acceptedDaa! + 600 + 20);
    await expect(as2(() => claimTimeoutMatch(rpc, p2, lone))).rejects.toThrow(/first round/);
    const p1Before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await splitTimeoutMatch(rpc, p1, lone);
    await waitGone(rpc, lone);
    expectPinnedHalf(await balanceAbove(rpc, p1, p1Before), p1Before);
  }, 900_000);

  test("a Quick Match joiner leaves a fresh lobby at once, refunded", async () => {
    const { rpc, p1, p2 } = await setup();
    const m = await openAndJoin(rpc, p1, p2, 600, true);
    expect(core(m).quick).toBe(1);
    // No age on the lobby UTXO at all: the covenant waives the joiner's wait.
    const p1Before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await cov.dissolveMatch(rpc, p2, m);
    await waitGone(rpc, m);
    expectPinnedHalf(await balanceAbove(rpc, p1, p1Before), p1Before);
  }, 900_000);

  test("divergent clients: a stale host re-derives the joiner's commit from the virtual chain", async () => {
    const { rpc, p1, p2 } = await setup();
    const cp0 = await cov.chainCheckpoint(rpc);
    let A = await as1(() =>
      cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 864_000 }, "fourk2"),
    );
    let B = decodeShareCode(encodeShareCode(A));
    B = await as2(() => cov.joinMatch(rpc, p2, B));
    expect((await cov.syncMatch(rpc, A)).status).toBe("terminated");
    A = (await cov.discoverAdvance(rpc, A, cp0))!;
    expect(A).not.toBeNull();
    expect(core(A).firstCommitter).toBe(0);

    // The joiner picks first. The host never saw the join output alive
    // (drop the stamp to model it), so re-deriving the commit successor
    // needs that output's acceptance score off the virtual chain — the
    // first pick stores no cutoff, but the covenant still reads the score
    // for the cap check, and the successor must match to the byte.
    const stale = engine.withoutEntry(A);
    B = await as2(() => commitMatch(rpc, p2, B, 4));
    expect(core(B).pickDeadline).toBe(0);
    expect((await cov.syncMatch(rpc, stale)).status).toBe("terminated");
    const adopted = await cov.discoverAdvance(rpc, stale, cp0);
    expect(adopted).not.toBeNull();
    expect(core(adopted!)).toEqual(core(B));
    expect(adopted!.txid).toBe(B.txid);
    // Without a checkpoint that predates the spent output, adoption cannot
    // manufacture the score — it declines rather than guessing.
    const cpAfter = await cov.chainCheckpoint(rpc);
    expect(
      await cov.adoptSpend(rpc, stale, (await cov.discoverSpend(rpc, stale, cp0))!, cpAfter),
    ).toBeNull();
    A = adopted!;

    // The host answers; the joiner (stale, stamped) follows the same way,
    // and the stored cutoff is the joiner's pick plus the window.
    const cpB = await cov.chainCheckpoint(rpc);
    A = await as1(() => commitMatch(rpc, p1, A, 1));
    expect(core(A).pickDeadline).toBe(B.acceptedDaa! + 600);
    expect((await cov.syncMatch(rpc, B)).status).toBe("terminated");
    const advancedB = await cov.discoverAdvance(rpc, B, cpB);
    expect(advancedB).not.toBeNull();
    expect(core(advancedB!)).toEqual(core(A));
    B = advancedB!;
    // Reveal race, then the resolve; enumeration carries the loser forward.
    A = await as1(() => revealMatch(rpc, p1, A));
    await expect(as2(() => revealMatch(rpc, p2, B))).rejects.toThrow(/game UTXO not found/);
    B = (await cov.syncMatch(rpc, B)).match;
    expect(phase(B)).toBe("resolve");
    B = await as2(() => revealMatch(rpc, p2, B));
    expect(core(B).round).toBe(1);
    const hostView = await cov.syncMatch(rpc, A);
    expect(hostView.status).toBe("advanced");
    expect([...hostView.match.state.board]).toEqual([...B.state.board]);
  }, 600_000);
});
