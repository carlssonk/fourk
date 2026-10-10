/**
 * Live end-to-end run against a LOCAL simnet node (localnet/live.sh, or
 * run-node.sh + mine.mjs), driving the app's real transaction engine
 * (covenant.ts) for both players from one process: classic play end to end,
 * the draw and game-limit doors, a staked game with cash-out, and the
 * dispenser. Fourk (fourk2) has its own suite, simul-v2-live.test.ts.
 *
 * Opt-in: SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run app/e2e/classic-live.test.ts
 * (from the repo root; the miner must be running or nothing confirms).
 */

import fs from "node:fs";
import { describe, expect, test } from "vitest";

const LIVE = process.env.SIMNET_E2E === "1";

// The engine touches localStorage (checkpoints) — stub it before the
// imports below evaluate.
const bag = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
};

import kaspaInit, * as kaspa from "kaspa-wasm";
import fourkInit from "fourk-wasm";
import * as cov from "../src/shared/lib/covenant";
import { moveMatch, winMatch } from "../src/shared/modes/classic/actions";
import { claimDrip, dispenserAddress } from "../src/shared/lib/dispenser";
import type { Match } from "../src/shared/lib/match";
import { decodeShareCode, encodeShareCode, isStaked } from "../src/shared/lib/match";

const NODE_URL = "ws://127.0.0.1:17510";
/** Mirrors MAX_FEE in contracts/fourk.ag: the pinned-payout doors are
 * self-funded (single input, fee shaved from the pot), so each pinned half
 * is at least (pot - MAX_FEE) / 2 — one stake minus half the fee ceiling. */
const MAX_FEE = 2_000_000n;
function expectPinnedHalf(after: bigint, before: bigint) {
  expect(after).toBeGreaterThanOrEqual(before + 1n * KAS - MAX_FEE / 2n);
  expect(after).toBeLessThan(before + 1n * KAS);
}
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

  // Bankroll both players from the miner-fed faucet key.
  await fundFromFaucet(
    rpc,
    faucet,
    [p1, p2].map((k) => [k.toAddress(NETWORK_TYPE).toString(), 20n * KAS]),
  );
  // Wait for the funding to be indexed.
  for (let i = 0; i < 60; i++) {
    const bal = await cov.walletBalance(rpc, cov.walletAddress(p1));
    if (bal >= 20n * KAS) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { rpc, p1, p2, faucet };
}

/** Pay `outputs` from the faucet key (coinbase-mature UTXOs only — the
 * miner pays this key directly). */
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

async function waitGone(rpc: cov.Rpc, m: Match) {
  for (let i = 0; i < 60; i++) {
    const { status } = await cov.syncMatch(rpc, m);
    if (status === "terminated") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("terminal spend never confirmed");
}

(LIVE ? describe : describe.skip)("classic mode on a live simnet chain", () => {
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
    await cov.drawMatch(rpc, p1, m); // p1 cranks; the fee comes out of the pot
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      if ((await cov.walletBalance(rpc, cov.walletAddress(p2))) > p2Before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // The non-cranking player's pinned half: one stake minus half the fee.
    expectPinnedHalf(await cov.walletBalance(rpc, cov.walletAddress(p2)), p2Before);
  }, 600_000);

  test("sudden_death: past the cap and the mover's clock, a begun game pays the waiting player", async () => {
    const { rpc, p1, p2 } = await setup();
    const until = async (score: number) => {
      for (let i = 0; i < 600; i++) {
        const info: any = await rpc.getBlockDagInfo();
        if (Number(info.virtualDaaScore) > score) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`chain never passed ${score}`);
    };
    // An unmoved game splits once both the cap and one move clock passed.
    let m = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 600 });
    m = await cov.joinMatch(rpc, p2, m);
    await until(Math.max(m.state.deadline, m.acceptedDaa! + 600));
    const p2Before = await cov.walletBalance(rpc, cov.walletAddress(p2));
    await cov.suddenDeathMatch(rpc, p1, m); // permissionless crank by p1
    await waitGone(rpc, m);
    for (let i = 0; i < 40; i++) {
      if ((await cov.walletBalance(rpc, cov.walletAddress(p2))) > p2Before) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expectPinnedHalf(await cov.walletBalance(rpc, cov.walletAddress(p2)), p2Before);

    // p1 moves, p2 stalls into the cap: the stall does not buy a split.
    let g = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: 600, totalCap: 600 });
    g = await cov.joinMatch(rpc, p2, g);
    g = await moveMatch(rpc, p1, g, 3);
    await until(Math.max(g.state.deadline, g.acceptedDaa! + 600));
    const p1Before = await cov.walletBalance(rpc, cov.walletAddress(p1));
    await cov.suddenDeathMatch(rpc, p2, g); // even the staller can only crank it
    await waitGone(rpc, g);
    let p1After = p1Before;
    for (let i = 0; i < 40 && p1After <= p1Before; i++) {
      await new Promise((r) => setTimeout(r, 500));
      p1After = await cov.walletBalance(rpc, cov.walletAddress(p1));
    }
    expect(p1After).toBeGreaterThanOrEqual(p1Before + 2n * KAS - MAX_FEE);
  }, 900_000);

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

  test("dispenser: an aged lane pays one drip to an empty wallet and re-locks the rest", async () => {
    const { rpc, faucet } = await setup();
    const DRIP = 10n * KAS;
    const LANE = 30n * KAS;
    // The claimant is a wallet with nothing in it: the claim is an unsigned,
    // pure-script spend and the fee comes out of the drip.
    const player = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey);
    const to = cov.walletAddress(player);
    const laneBefore = await cov.walletBalance(rpc, dispenserAddress());

    await fundFromFaucet(rpc, faucet, [[dispenserAddress(), LANE]]);

    // The lane is claimable once it has aged COOLDOWN (1200 DAA ≈ 2 min of
    // simnet mining); claimDrip refuses earlier and the node would too.
    let txid = "";
    let lastError: unknown = null;
    for (let i = 0; i < 300 && !txid; i++) {
      try {
        txid = await claimDrip(rpc, to);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(txid, String(lastError)).not.toBe("");

    let got = 0n;
    for (let i = 0; i < 40 && got === 0n; i++) {
      await new Promise((r) => setTimeout(r, 500));
      got = await cov.walletBalance(rpc, to);
    }
    // One drip minus the claim's fee lands; the lane re-locks exactly the rest.
    expect(got).toBeGreaterThanOrEqual(DRIP - MAX_FEE);
    expect(got).toBeLessThan(DRIP);
    expect(await cov.walletBalance(rpc, dispenserAddress())).toBe(laneBefore + LANE - DRIP);
  }, 600_000);
});
