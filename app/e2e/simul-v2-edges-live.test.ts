/**
 * Fourk V2 edges on a LOCAL simnet node, with the chain under the test's
 * control: the background miner is held (MINE_PAUSE_FILE, see
 * localnet/live.sh) and blocks are mined one at a time, so a transaction can
 * be made to land at an exact DAA score. What the other live suites cannot
 * show:
 *
 *   - the lock-time boundary as consensus applies it: a lone pick's claim is
 *     refused while the virtual score equals its lock and accepted one block
 *     later (and the client check agrees);
 *   - the acceptance boundary: a second pick accepted exactly at the cutoff
 *     is revealed; one accepted a block later pays the first committer;
 *   - a real race on the node between a timeout claim and a late second
 *     pick: exactly one lands and the first committer is paid either way;
 *   - the doors no other live run reaches: the cap paying a decided owner,
 *     the cap splitting an untouched round, claim_split, and claim_draw.
 *
 * Opt-in: run through localnet/live.sh (needs MINE_PAUSE_FILE).
 */

import fs from "node:fs";
import { describe, expect, test } from "vitest";

const LIVE = process.env.SIMNET_E2E === "1" && !!process.env.MINE_PAUSE_FILE;

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
import { classifyFailure } from "../src/shared/lib/errors";
import {
  claimSplitMatch,
  claimTimeoutMatch,
  claimWinMatch,
  commitMatch,
  revealMatch,
  suddenDeathMatch,
} from "../src/shared/modes/fourk2/actions";
import { core2Of } from "../src/shared/modes/fourk2/core";
import { fourk2Engine } from "../src/shared/modes/fourk2/engine";
import { REBASE_GRACE_DAA } from "../../src/simul-v2/rules";
import { findWin } from "../src/shared/lib/game";
import type { Match } from "../src/shared/lib/match";

const NODE_URL = process.env.KASPA_RPC_URL ?? "ws://127.0.0.1:17510";
const PAUSE_FILE = process.env.MINE_PAUSE_FILE ?? "";
const NETWORK_TYPE = "simnet";
const KAS = 100_000_000n;
const MAX_FEE = 2_000_000n;
const T = 600;
const FAUCET_KEY_FILE = new URL("../../faucet/faucet.key", import.meta.url);
const KASPA_WASM = new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url);
const FOURK_WASM = new URL("../../wasm/pkg/fourk_wasm_bg.wasm", import.meta.url);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- The chain under control -------------------------------------------------

let miner = "";

function hold() {
  fs.writeFileSync(PAUSE_FILE, "");
}
function release() {
  fs.rmSync(PAUSE_FILE, { force: true });
}

async function daaNow(rpc: cov.Rpc): Promise<number> {
  const info: any = await rpc.getBlockDagInfo();
  return Number(info.virtualDaaScore);
}

/** Mine one block on top of the current virtual (the background miner must
 * be held). */
async function mineBlock(rpc: cov.Rpc) {
  const { block } = await rpc.getBlockTemplate({ payAddress: miner } as any);
  const pow = new kaspa.PoW((block as any).header);
  for (let nonce = 0n; ; nonce++) {
    if (pow.checkWork(nonce)[0]) {
      (block as any).header.nonce = nonce;
      break;
    }
  }
  const { report } = await rpc.submitBlock({ block, allowNonDAABlocks: false } as any);
  if ((report as any).type !== "success")
    throw new Error(`block rejected: ${(report as any).reason}`);
}

/** Hold the miner and mine until the virtual score is exactly `target`
 * (one block per DAA step on a single-miner chain). */
async function mineTo(rpc: cov.Rpc, target: number) {
  hold();
  for (let i = 0; i < 100_000; i++) {
    const now = await daaNow(rpc);
    if (now >= target) {
      expect(now).toBe(target);
      return;
    }
    await mineBlock(rpc);
  }
  throw new Error(`never reached DAA ${target}`);
}

/** Mine until the virtual score is at least `target`, as fast as possible. */
async function fastForward(rpc: cov.Rpc, target: number) {
  hold();
  while ((await daaNow(rpc)) < target) await mineBlock(rpc);
}

/** Mine one block, then wait until `m`'s UTXO is indexed. */
async function confirm(rpc: cov.Rpc, m: Match): Promise<Match> {
  for (let i = 0; i < 40; i++) {
    const entry = await engine.fetchGameUtxo(rpc, fourk2Engine, m);
    if (entry) return engine.withEntry(m, entry);
    await mineBlock(rpc);
  }
  throw new Error("transition never indexed");
}

// --- Players -----------------------------------------------------------------

async function setup() {
  await kaspaInit(fs.readFileSync(KASPA_WASM));
  await fourkInit(fs.readFileSync(FOURK_WASM));
  const rpc = await cov.connect(NODE_URL);
  const faucet = new kaspa.PrivateKey(fs.readFileSync(FAUCET_KEY_FILE, "utf8").trim());
  miner = faucet.toAddress(NETWORK_TYPE).toString();
  release();
  const p1 = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey);
  const p2 = new kaspa.PrivateKey(kaspa.Keypair.random().privateKey);
  const { entries } = await rpc.getUtxosByAddresses([miner]);
  const now = BigInt(await daaNow(rpc));
  const spendable = (entries as any[]).filter((e) => {
    if (!(e.isCoinbase ?? e.entry?.isCoinbase)) return true;
    return now - BigInt(e.blockDaaScore ?? e.entry?.blockDaaScore ?? 0n) >= 1000n;
  });
  const { transactions } = await kaspa.createTransactions({
    entries: spendable,
    outputs: [p1, p2].map((k) => ({
      address: k.toAddress(NETWORK_TYPE).toString(),
      amount: 20n * KAS,
    })),
    changeAddress: miner,
    priorityFee: 5_000_000n,
    networkId: "simnet",
  });
  for (const pending of transactions) {
    await pending.sign([faucet]);
    await pending.submit(rpc);
  }
  for (let i = 0; i < 60; i++) {
    if ((await cov.walletBalance(rpc, cov.walletAddress(p2))) >= 20n * KAS) break;
    await sleep(500);
  }
  return { rpc, p1, p2 };
}

const balanceOf = (rpc: cov.Rpc, k: kaspa.PrivateKey) =>
  cov.walletBalance(rpc, cov.walletAddress(k));

async function settleAndPay(rpc: cov.Rpc, k: kaspa.PrivateKey, before: bigint): Promise<bigint> {
  for (let i = 0; i < 40; i++) {
    const now = await balanceOf(rpc, k);
    if (now > before) return now;
    await mineBlock(rpc);
  }
  return balanceOf(rpc, k);
}

async function openAndJoin(
  rpc: cov.Rpc,
  p1: kaspa.PrivateKey,
  p2: kaspa.PrivateKey,
  totalCap = 864_000,
) {
  let m = await cov.openMatch(rpc, p1, 1n * KAS, { moveTimeout: T, totalCap }, "fourk2");
  m = await cov.joinMatch(rpc, p2, m);
  return m;
}

/** Play the first round (p1 column `a`, p2 column `b`) to the second
 * round's start. Runs with the background miner. */
async function round(
  rpc: cov.Rpc,
  p1: kaspa.PrivateKey,
  p2: kaspa.PrivateKey,
  m: Match,
  a: number,
  b: number,
) {
  const one = await as1(() => commitMatch(rpc, p1, m, a));
  const two = await as2(() => commitMatch(rpc, p2, one, b));
  const shown = await as1(() => revealMatch(rpc, p1, two));
  return as2(() => revealMatch(rpc, p2, shown));
}

(LIVE ? describe : describe.skip)("fourk V2 edges on a controlled simnet chain", () => {
  test("a lone pick's claim is refused at its lock score and accepted one block later", async () => {
    const { rpc, p1, p2 } = await setup();
    try {
      let m = await openAndJoin(rpc, p1, p2);
      m = await round(rpc, p1, p2, m, 0, 1);
      const one = await as1(() => commitMatch(rpc, p1, m, 2));
      const lock = Math.max(core2Of(one).pickDeadline, one.acceptedDaa! + REBASE_GRACE_DAA);
      await mineTo(rpc, lock);
      // The client check agrees with consensus: not yet at the lock itself.
      await expect(as1(() => claimTimeoutMatch(rpc, p1, one))).rejects.toThrow(
        /deadline not reached/,
      );
      // And so does the node, asked directly with the same transaction shape.
      const direct = () =>
        engine.signedTerminal(rpc, p1, fourk2Engine, one, "claim_timeout", [{ sig: 0 }], 0n, {
          lockTime: BigInt(lock),
        });
      const early = await direct().then(
        () => null,
        (e) => e,
      );
      expect(early).not.toBeNull();
      expect(classifyFailure(early)).toBe("premature");
      await mineBlock(rpc);
      const before = await balanceOf(rpc, p1);
      await direct();
      expect(await settleAndPay(rpc, p1, before)).toBeGreaterThan(
        before + 2n * KAS - MAX_FEE - KAS / 10n,
      );
    } finally {
      release();
    }
  }, 600_000);

  test("a second pick accepted at the cutoff reveals; one block later the first committer is paid", async () => {
    const { rpc, p1, p2 } = await setup();
    try {
      for (const late of [false, true]) {
        let m = await openAndJoin(rpc, p1, p2);
        m = await round(rpc, p1, p2, m, 0, 1);
        // Calibrate: where does a transaction submitted at virtual score X
        // get accepted once one block is mined?
        hold();
        const x0 = await daaNow(rpc);
        const one = await as1(() => commitMatch(rpc, p1, m, 2));
        const oneSeen = await confirm(rpc, one);
        const offset = oneSeen.acceptedDaa! - x0;
        expect(offset).toBeGreaterThanOrEqual(0);
        const cutoff = core2Of(oneSeen).pickDeadline;
        // Land the second pick exactly at the cutoff, or one past it.
        const target = cutoff + (late ? 1 : 0);
        await mineTo(rpc, target - offset);
        const two = await as2(() => commitMatch(rpc, p2, oneSeen, 3));
        const twoSeen = await confirm(rpc, two);
        expect(twoSeen.acceptedDaa).toBe(target);
        release();
        if (!late) {
          const shown = await as1(() => revealMatch(rpc, p1, twoSeen));
          expect(core2Of(shown).reveal1).toBe(3);
        } else {
          await expect(as1(() => revealMatch(rpc, p1, twoSeen))).rejects.toThrow(/late/);
          const before = await balanceOf(rpc, p1);
          await as1(() => claimTimeoutMatch(rpc, p1, twoSeen));
          expect(await settleAndPay(rpc, p1, before)).toBeGreaterThan(before + KAS);
        }
      }
    } finally {
      release();
    }
  }, 900_000);

  test("a timeout claim and a late second pick race on the node: one lands, the first committer wins", async () => {
    const { rpc, p1, p2 } = await setup();
    try {
      for (const claimFirst of [true, false]) {
        let m = await openAndJoin(rpc, p1, p2);
        m = await round(rpc, p1, p2, m, 0, 1);
        const one = await as1(() => commitMatch(rpc, p1, m, 2));
        const lock = Math.max(core2Of(one).pickDeadline, one.acceptedDaa! + REBASE_GRACE_DAA);
        await mineTo(rpc, lock + 1);
        const low = await cov.chainCheckpoint(rpc);
        const claim = () => as1(() => claimTimeoutMatch(rpc, p1, one));
        const pick = () => as2(() => commitMatch(rpc, p2, one, 3));
        const [a, b] = claimFirst ? [claim(), pick()] : [pick(), claim()];
        const results = await Promise.allSettled([a, b]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(classifyFailure(lost.reason)).toBe("stale");
        // Whichever landed, the first committer collects.
        const before = await balanceOf(rpc, p1);
        await mineBlock(rpc);
        const followed = await cov.syncMatch(rpc, one);
        if (followed.status !== "terminated") {
          // The late pick won the input: its successor is a late second pick.
          const next = await cov.followChain(rpc, one, low);
          expect(next.status).toBe("advanced");
          await as1(() => claimTimeoutMatch(rpc, p1, next.match));
        }
        expect(await settleAndPay(rpc, p1, before)).toBeGreaterThan(before + KAS);
        release();
      }
    } finally {
      release();
    }
  }, 900_000);

  test("the cap pays a decided owner in full and splits an untouched round", async () => {
    const { rpc, p1, p2 } = await setup();
    try {
      // A lone timely pick at the cap: the first committer is paid in full.
      let m = await openAndJoin(rpc, p1, p2, 6_000);
      m = await round(rpc, p1, p2, m, 0, 1);
      const one = await as1(() => commitMatch(rpc, p1, m, 2));
      const lock = Math.max(
        m.state.deadline,
        core2Of(one).pickDeadline,
        one.acceptedDaa! + REBASE_GRACE_DAA,
      );
      await fastForward(rpc, lock + 1);
      let before = await balanceOf(rpc, p1);
      await suddenDeathMatch(rpc, p2, one); // anyone may crank it
      expect(await settleAndPay(rpc, p1, before)).toBeGreaterThan(before + 2n * KAS - MAX_FEE - 1n);
      release();

      // A round nobody picked in, past the cap: an even split.
      m = await openAndJoin(rpc, p1, p2, 6_000);
      m = await round(rpc, p1, p2, m, 0, 1);
      await fastForward(rpc, Math.max(m.state.deadline, m.acceptedDaa! + T) + 1);
      before = await balanceOf(rpc, p2);
      await suddenDeathMatch(rpc, p1, m);
      const after = await settleAndPay(rpc, p2, before);
      expect(after).toBeGreaterThanOrEqual(before + KAS - MAX_FEE / 2n);
      expect(after).toBeLessThan(before + KAS);
    } finally {
      release();
    }
  }, 900_000);

  test("a double win is contested into the split; a full board settles as a draw", async () => {
    const { rpc, p1, p2 } = await setup();
    try {
      // Four rounds of p1 in column 0, p2 in column 1: both lines complete in
      // the same resolve. p1 claims; anyone contests with both witnesses.
      let m = await openAndJoin(rpc, p1, p2);
      for (let i = 0; i < 4; i++) m = await round(rpc, p1, p2, m, 0, 1);
      const w1 = findWin(m.state.board, 1)!;
      const w2 = findWin(m.state.board, 2)!;
      expect(w1 && w2).toBeTruthy();
      const pending = await as1(() => claimWinMatch(rpc, p1, m, w1));
      expect(core2Of(pending).pendingWin).toBe(1);
      let before = await balanceOf(rpc, p2);
      await claimSplitMatch(rpc, p2, pending, w1, w2);
      let after = await settleAndPay(rpc, p2, before);
      expect(after).toBeGreaterThanOrEqual(before + KAS - MAX_FEE / 2n);
      expect(after).toBeLessThan(before + KAS);

      // Same-column picks fill a column two discs a round; 21 rounds fill
      // the board. The draw waits out the reveal grace after the last disc.
      m = await openAndJoin(rpc, p1, p2);
      for (let c = 0; c < 7; c++) for (let i = 0; i < 3; i++) m = await round(rpc, p1, p2, m, c, c);
      expect(m.state.board.every((x) => x !== 0)).toBe(true);
      await fastForward(rpc, m.acceptedDaa! + core2Of(m).revealTimeout + 1);
      before = await balanceOf(rpc, p2);
      await cov.drawMatch(rpc, p1, m);
      after = await settleAndPay(rpc, p2, before);
      expect(after).toBeGreaterThanOrEqual(before + KAS - MAX_FEE / 2n);
    } finally {
      release();
    }
  }, 1_800_000);
});
