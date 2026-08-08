/**
 * Live end-to-end run against a LOCAL simnet node (localnet/run-node.sh +
 * mine.mjs), driving the app's real transaction engine (covenant.ts) for
 * both players from one process. Covers the fourk-mode round machine on a
 * real chain — join, commits, reveals, resolves, collisions, the win claim,
 * the timeout claim — plus a classic-mode regression game.
 *
 * Opt-in: SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run app/e2e/simul-live.test.ts
 * (from the repo root; the miner must be running or nothing confirms).
 */

import fs from "node:fs";
import { describe, expect, test } from "vitest";

const LIVE = process.env.SIMNET_E2E === "1";

// covenant.ts touches localStorage through the salt store — stub it before
// the imports below evaluate. Each player gets their OWN bag (in reality a
// player is a browser); `as1`/`as2` select whose storage a call runs with.
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
import {
  claimSplitMatch,
  claimTimeoutMatch,
  claimWinMatch,
  commitMatch,
  revealMatch,
  sweepWinMatch,
} from "../src/shared/modes/fourk/actions";
import { moveMatch, winMatch } from "../src/shared/modes/classic/actions";
import type { Match } from "../src/shared/lib/match";
import { loadSalt } from "../src/shared/modes/fourk/saltStore";
import { ZERO_CORE, ZERO_HASH, roundPhase, toSimulState } from "../src/shared/modes/fourk/core";
import { cellIndex } from "../src/shared/lib/game";
import { decodeShareCode, encodeShareCode, isStaked } from "../src/shared/lib/match";

const NODE_URL = "ws://127.0.0.1:17510";
const NETWORK_TYPE = "simnet";
const KAS = 100_000_000n;

const FAUCET_KEY_FILE = new URL("../../faucet/faucet.key", import.meta.url);
const KASPA_WASM = new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url);
const FOURK_WASM = new URL("../../wasm/pkg/fourk_wasm_bg.wasm", import.meta.url);

async function setup() {
  await kaspaInit(fs.readFileSync(KASPA_WASM));
  await fourkInit(fs.readFileSync(FOURK_WASM));
  const rpc = await cov.connect(NODE_URL);

  const faucet = new kaspa.PrivateKey(fs.readFileSync(FAUCET_KEY_FILE, "utf8").trim());
  const p1 = new kaspa.PrivateKey("aa".repeat(32));
  const p2 = new kaspa.PrivateKey("bb".repeat(32));

  // Bankroll both players from the miner-fed faucet key (coinbase-mature
  // UTXOs only — the miner pays this key directly).
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
    outputs: [p1, p2].map((k) => ({
      address: k.toAddress(NETWORK_TYPE).toString(),
      amount: 20n * KAS,
    })),
    changeAddress: from,
    priorityFee: 5_000_000n,
    networkId: "simnet",
  });
  for (const pending of transactions) {
    await pending.sign([faucet]);
    await pending.submit(rpc);
  }
  // Wait for the funding to be indexed.
  for (let i = 0; i < 60; i++) {
    const bal = await cov.walletBalance(rpc, cov.walletAddress(p1));
    if (bal >= 20n * KAS) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { rpc, p1, p2 };
}

function core(m: Match) {
  return m.simul ?? ZERO_CORE;
}

function phase(m: Match) {
  return roundPhase(toSimulState(m.state, core(m)));
}

async function waitGone(rpc: cov.Rpc, m: Match) {
  for (let i = 0; i < 60; i++) {
    const { status } = await cov.syncMatch(rpc, m);
    if (status === "terminated") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("terminal spend never confirmed");
}

(LIVE ? describe : describe.skip)("fourk mode on a live simnet chain", () => {
  test("a full fourk game: rounds, collisions, vanish-free win, claim_win", async () => {
    const { rpc, p1, p2 } = await setup();

    // Open (fourk mode) and join.
    let m = await cov.openMatch(
      rpc,
      p1,
      1n * KAS,
      { moveTimeout: 600, totalCap: 864_000 },
      "fourk",
    );
    expect(m.mode).toBe("fourk");
    expect(m.state.p2).toBe("00".repeat(32));
    m = await cov.joinMatch(rpc, p2, m);
    expect(m.value).toBe(2n * KAS);
    expect(phase(m)).toBe("commit");

    // The invite share code carries the mode + round machine.
    const decoded = decodeShareCode(encodeShareCode(m));
    expect(decoded.mode).toBe("fourk");
    expect(decoded.simul).toEqual(core(m));

    // Round 0: a collision — both seal column 3. Priority p1 lands lower.
    m = await as1(() => commitMatch(rpc, p1, m, 3));
    expect(core(m).commit1).not.toBe(ZERO_HASH);
    expect(cov.isActionable(m, cov.walletPubkey(p1))).toBe(false);
    expect(cov.isActionable(m, cov.walletPubkey(p2))).toBe(true);
    m = await as2(() => commitMatch(rpc, p2, m, 3));
    expect(phase(m)).toBe("reveal");
    m = await as1(() => revealMatch(rpc, p1, m)); // first reveal
    expect(phase(m)).toBe("resolve");
    m = await as2(() => revealMatch(rpc, p2, m)); // resolve: both discs drop
    expect(core(m).round).toBe(1);
    expect(m.state.board[cellIndex(3, 0)]).toBe(1);
    expect(m.state.board[cellIndex(3, 1)]).toBe(2);

    // Round 1: collision again — priority alternates, p2 lands lower.
    m = await as2(() => commitMatch(rpc, p2, m, 2)); // either commit order works
    m = await as1(() => commitMatch(rpc, p1, m, 2));
    m = await as2(() => revealMatch(rpc, p2, m));
    m = await as1(() => revealMatch(rpc, p1, m));
    expect(core(m).round).toBe(2);
    expect(m.state.board[cellIndex(2, 0)]).toBe(2);
    expect(m.state.board[cellIndex(2, 1)]).toBe(1);

    // Rounds 2-4: p1 lays row 0 across 4,5,6 (with (3,0) already theirs);
    // p2 stacks column 0 — three high, harmless.
    for (const [colP1, colP2] of [
      [4, 0],
      [5, 0],
      [6, 0],
    ] as const) {
      m = await as1(() => commitMatch(rpc, p1, m, colP1));
      m = await as2(() => commitMatch(rpc, p2, m, colP2));
      m = await as1(() => revealMatch(rpc, p1, m));
      m = await as2(() => revealMatch(rpc, p2, m));
    }
    expect(core(m).round).toBe(5);
    for (const c of [3, 4, 5, 6]) expect(m.state.board[cellIndex(c, 0)]).toBe(1);

    // The winner's line is claimed on the CURRENT board — even though p2
    // resolved the final round. The claim opens the CHALLENGE WINDOW: a
    // pending-win continuation, not a payout.
    const before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    m = await as1(() => claimWinMatch(rpc, p1, m, { col: 3, row: 0, dir: 0 }));
    expect(core(m).pendingWin).toBe(1);
    expect(core(m).commit1).toBe(ZERO_HASH);
    expect(cov.isActionable(m, cov.walletPubkey(p2))).toBe(false);

    // The sweep is sequence-locked for one move clock: an early attempt is
    // rejected by CONSENSUS, not just policy.
    await expect(sweepWinMatch(rpc, p1, m)).rejects.toThrow();

    // Wait out the window (~600 DAA ≈ one minute of simnet mining), then
    // the winner sweeps the pot.
    for (let i = 0; i < 240; i++) {
      const age = await cov.gameUtxoAge(rpc, m);
      if (age !== null && age >= 600) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await sweepWinMatch(rpc, p1, m);
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      const after = await cov.walletBalance(rpc, cov.walletAddress(p1));
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const after = await cov.walletBalance(rpc, cov.walletAddress(p1));
    expect(after).toBeGreaterThan(before + 2n * KAS - KAS / 10n); // pot minus fee
  }, 600_000);

  test("challenge window: a greedy double-win claim is contested into the fair split", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await cov.openMatch(
      rpc,
      p1,
      1n * KAS,
      { moveTimeout: 600, totalCap: 864_000 },
      "fourk",
    );
    m = await cov.joinMatch(rpc, p2, m);

    // Build a genuine on-chain double win: collisions stack p1-under-p2 on
    // even (p1-priority) rounds, so cols 3..6 fill row 0 with p1 and row 1
    // with p2 — the LAST collision (col 6, round 6) completes both lines in
    // one resolve. Odd rounds burn on col 0/1 fillers (p2 low — harmless).
    const rounds: Array<[number, number]> = [
      [3, 3],
      [0, 0],
      [4, 4],
      [1, 1],
      [5, 5],
      [0, 0],
      [6, 6],
    ];
    for (const [colP1, colP2] of rounds) {
      m = await as1(() => commitMatch(rpc, p1, m, colP1));
      m = await as2(() => commitMatch(rpc, p2, m, colP2));
      m = await as1(() => revealMatch(rpc, p1, m));
      m = await as2(() => revealMatch(rpc, p2, m));
    }
    for (const c of [3, 4, 5, 6]) {
      expect(m.state.board[cellIndex(c, 0)]).toBe(1);
      expect(m.state.board[cellIndex(c, 1)]).toBe(2);
    }

    // P1 greedily claims with only their own line — the old mempool-race
    // theft. Now it just opens the window...
    m = await as1(() => claimWinMatch(rpc, p1, m, { col: 3, row: 0, dir: 0 }));
    expect(core(m).pendingWin).toBe(1);

    // ...and P2 contests at leisure with both witnesses. Pinned payouts:
    // each player gets exactly their stake back.
    const p1Before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await as2(() =>
      claimSplitMatch(rpc, p2, m, { col: 3, row: 0, dir: 0 }, { col: 3, row: 1, dir: 0 }),
    );
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      if ((await cov.walletBalance(rpc, cov.walletAddress(p1))) > p1Before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await cov.walletBalance(rpc, cov.walletAddress(p1))).toBe(p1Before + 1n * KAS);
    expect(await cov.walletBalance(rpc, cov.walletAddress(p2))).toBeGreaterThan(
      p2Before + 1n * KAS - KAS / 10n, // their stake back, minus the contest fee
    );
  }, 600_000);

  test("claim_timeout: the lone committer collects after the round clock", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await cov.openMatch(
      rpc,
      p1,
      1n * KAS,
      { moveTimeout: 600, totalCap: 864_000 },
      "fourk",
    );
    m = await cov.joinMatch(rpc, p2, m);
    m = await as1(() => commitMatch(rpc, p1, m, 0));
    // The salt store holds the round's pick (survives-a-refresh equivalent).
    expect(loadSalt(m.covenantId, 0)?.col).toBe(0);

    // P2 goes silent. 600 DAA at ~10 blocks/s ≈ 1 minute of miner time.
    for (let i = 0; i < 180; i++) {
      const age = await cov.gameUtxoAge(rpc, m);
      if (age !== null && age >= 600) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await claimTimeoutMatch(rpc, p1, m);
    await waitGone(rpc, m);
  }, 600_000);

  test("divergent clients: sync + discovery carry a stale client through a full round", async () => {
    // The play-test scenario: each player's client holds its OWN Match and
    // only learns about the opponent through syncMatch / discover* — the
    // exact paths the shared-object test above never exercises.
    const { rpc, p1, p2 } = await setup();

    // Host opens; the pre-open checkpoint is what the app saves at creation.
    const cp0 = await cov.chainCheckpoint(rpc);
    let A = await as1(() =>
      cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 864_000 }, "fourk"),
    );

    // Joiner takes the seat from the share code (the invite-link path).
    let B = decodeShareCode(encodeShareCode(A));
    B = await as2(() => cov.joinMatch(rpc, p2, B));

    // Host side: the lobby UTXO is gone; enumeration can't find a join —
    // discovery must (this is the open-phase watcher's flow).
    expect((await cov.syncMatch(rpc, A)).status).toBe("terminated");
    const joined = await cov.discoverAdvance(rpc, A, cp0);
    expect(joined).not.toBeNull();
    A = joined!;
    expect(A.state.p2).toBe(cov.walletPubkey(p2));
    expect(A.simul).toEqual(ZERO_CORE);

    // Joiner commits first. The host's client is now stale in the commit
    // phase — enumeration is blind there, discovery must adopt the commit.
    const cpA = await cov.chainCheckpoint(rpc);
    B = await as2(() => commitMatch(rpc, p2, B, 4));
    expect((await cov.syncMatch(rpc, A)).status).toBe("terminated");
    const advanced = await cov.discoverAdvance(rpc, A, cpA);
    expect(advanced).not.toBeNull();
    A = advanced!;
    expect(A.simul!.commit2).toBe(B.simul!.commit2);

    // Host commits; the joiner (stale again) discovers it the same way.
    const cpB = await cov.chainCheckpoint(rpc);
    A = await as1(() => commitMatch(rpc, p1, A, 1));
    expect((await cov.syncMatch(rpc, B)).status).toBe("terminated");
    const advancedB = await cov.discoverAdvance(rpc, B, cpB);
    expect(advancedB).not.toBeNull();
    B = advancedB!;
    expect(B.simul!.commit1).toBe(A.simul!.commit1);

    // Reveal race: the host reveals; the joiner — still holding the
    // both-commits state — tries to reveal too and loses. Plain syncMatch
    // must then carry the joiner forward (reveal successors ARE enumerable).
    A = await as1(() => revealMatch(rpc, p1, A));
    await expect(as2(() => revealMatch(rpc, p2, B))).rejects.toThrow(/game UTXO not found/);
    const caughtUp = await cov.syncMatch(rpc, B);
    expect(caughtUp.status).toBe("advanced");
    B = caughtUp.match;
    expect(phase(B)).toBe("resolve");

    // The joiner resolves; the host follows by enumeration alone.
    B = await as2(() => revealMatch(rpc, p2, B));
    expect(core(B).round).toBe(1);
    const hostView = await cov.syncMatch(rpc, A);
    expect(hostView.status).toBe("advanced");
    expect([...hostView.match.state.board]).toEqual([...B.state.board]);
    expect(hostView.match.state.board[cellIndex(1, 0)]).toBe(1);
    expect(hostView.match.state.board[cellIndex(4, 0)]).toBe(2);
  }, 600_000);

  test("claim_draw: a full classic board splits the pot", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 864_000 });
    m = await cov.joinMatch(rpc, p2, m);
    // Fill all 42 cells column by column. Plain moves never check wins —
    // unclaimed lines just sit there, and the covenant's documented edge is
    // that a full board with unclaimed wins still draws.
    for (let col = 0; col < 7; col++) {
      for (let r = 0; r < 6; r++) {
        const key = m.state.moveCount % 2 === 0 ? p1 : p2;
        m = await moveMatch(rpc, key, m, col);
      }
    }
    expect(m.state.moveCount).toBe(42);
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await cov.drawMatch(rpc, p1, m); // p1 cranks; fees ride p1's funding input
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      if ((await cov.walletBalance(rpc, cov.walletAddress(p2))) > p2Before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // The non-cranking player's pinned half arrives whole: exactly one stake.
    expect(await cov.walletBalance(rpc, cov.walletAddress(p2))).toBe(p2Before + 1n * KAS);
  }, 600_000);

  test("sudden_death: a capped game splits once the chain passes its deadline", async () => {
    const { rpc, p1, p2 } = await setup();
    // totalCap 600 DAA ≈ one minute of simnet mining.
    let m = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 600 });
    expect(m.state.deadline).toBeGreaterThan(0);
    m = await cov.joinMatch(rpc, p2, m);
    for (let i = 0; i < 240; i++) {
      const info: any = await rpc.getBlockDagInfo();
      if (Number(info.virtualDaaScore) >= m.state.deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await cov.suddenDeathMatch(rpc, p1, m); // permissionless crank by p1
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      if ((await cov.walletBalance(rpc, cov.walletAddress(p2))) > p2Before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await cov.walletBalance(rpc, cov.walletAddress(p2))).toBe(p2Before + 1n * KAS);
  }, 600_000);

  test("classic mode still works end to end (regression)", async () => {
    const { rpc, p1, p2 } = await setup();
    let m = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 864_000 });
    expect(m.mode).toBeUndefined();
    m = await cov.joinMatch(rpc, p2, m);
    // p1 stacks column 0, p2 column 1; p1's fourth disc is a winning_move.
    for (const [key, col] of [
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
    ] as const) {
      m = await moveMatch(rpc, key, m, col);
    }
    await winMatch(rpc, p1, m, 0, { col: 0, row: 0, dir: 1 });
    await waitGone(rpc, m);
  }, 600_000);

  test("staked game: the stake says so on-chain, the pot pays the winner, cash-out sweeps", async () => {
    const { rpc, p1, p2 } = await setup();
    const stake = 5n * KAS;

    let m = await cov.openMatch(rpc, p1, stake, { moveTimeout: 600, totalCap: 864_000 }, "classic");
    expect(isStaked(m)).toBe(true);

    // Nothing marks the game staked: the stake itself does, and it is the
    // covenant's own, so an invite cannot claim otherwise.
    const invite = decodeShareCode(encodeShareCode(m));
    expect(invite.state.stake).toBe(stake);
    expect(isStaked(invite)).toBe(true);

    // The join doubles the pot; the stake per seat is unchanged.
    m = await cov.joinMatch(rpc, p2, invite);
    expect(m.value).toBe(2n * stake);
    expect(isStaked(m)).toBe(true);

    // p1 stacks column 0 to a winning_move; the pot lands in p1's balance.
    for (const [key, col] of [
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
    ] as const) {
      m = await moveMatch(rpc, key, m, col);
      expect(isStaked(m)).toBe(true);
    }
    const before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await winMatch(rpc, p1, m, 0, { col: 0, row: 0, dir: 1 });
    await waitGone(rpc, m);
    let after = before;
    for (let i = 0; i < 40 && after <= before; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await cov.walletBalance(rpc, cov.walletAddress(p1));
    }
    expect(after).toBeGreaterThan(before + 2n * stake - KAS / 10n); // pot minus fees

    // Cash out: sweep the whole balance to a fresh address; the wallet ends
    // empty and the destination holds exactly what sendTo reported.
    const dest = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey)
      .toAddress(NETWORK_TYPE)
      .toString();
    const res = await cov.sendTo(rpc, p1, dest, "all");
    expect(res.amount).toBeGreaterThan(0n);
    let landed = 0n;
    for (let i = 0; i < 40 && landed === 0n; i++) {
      await new Promise((r) => setTimeout(r, 500));
      landed = await cov.walletBalance(rpc, dest);
    }
    expect(landed).toBe(res.amount);
    expect(await cov.walletBalance(rpc, cov.walletAddress(p1))).toBe(0n);

    // A wrong-network destination is refused before anything is spent.
    await expect(
      cov.sendTo(
        rpc,
        p2,
        "kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh",
        KAS,
      ),
    ).rejects.toThrow("BAD_ADDRESS");
  }, 600_000);
});
