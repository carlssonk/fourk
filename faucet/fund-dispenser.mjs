#!/usr/bin/env node
// Operate the on-chain dispenser (contracts/drip.sil): check its lane health
// or send TKAS lanes to its fixed address from a funded key. Each output
// becomes an independent drip lane on its own cooldown.
//
//     node fund-dispenser.mjs status
//     node fund-dispenser.mjs <keyfile> [lanes=3] [tkas-per-lane=100] [--dry-run]
//
// `status` exits 0 when the dispenser looks healthy and 1 when a refill is
// recommended, so a cron job can alert on the exit code (see RUNBOOK.md).
// `--dry-run` prints what a refill would send without submitting anything.

import fs from "node:fs";
import init, * as kaspa from "../vendor/kaspa-wasm/kaspa.js";

await init(fs.readFileSync(new URL("../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url)));

// Keep in sync with contracts/drip.sil — harness/tests/drip_tests.rs prints it.
const DRIP_REDEEM_HEX = "b3519c6902b004b1b9be760400ca9a3ba06300c3b9bf876900c2780400ca9a3b94a26968007a7551";

// Keep in sync with COOLDOWN_DAA / DRIP_SOMPI / DUST in
// app/src/shared/lib/dispenser.ts (which match contracts/drip.sil).
const COOLDOWN_DAA = 1200n; // ~2 min: 1 DAA block ≈ 100 ms
const DRIP_SOMPI = 1_000_000_000n; // 10 TKAS per claim
const DUST = 20_000n; // a lane at or below this can't even pay its own fee

// Health thresholds for `status`: each free game consumes ~2 claims, so the
// float should cover a comfortable buffer of games even if some lanes are
// mid-cooldown.
const MIN_ELIGIBLE_LANES = 2;
const MIN_TOTAL_DRIPS = 10n; // total balance below 10 drips => refill

// Default keeps in sync with NETWORK_ID in app/src/shared/lib/match.ts;
// KASPA_NETWORK_ID overrides for a private chain (see localnet/README.md).
const NETWORK_ID = process.env.KASPA_NETWORK_ID ?? "testnet-10";
const NETWORK_TYPE = NETWORK_ID.split("-")[0];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const [command, ...rest] = argv.filter((a) => a !== "--dry-run");
if (!command) {
  console.error(
    [
      "usage: node fund-dispenser.mjs status",
      "       node fund-dispenser.mjs <keyfile> [lanes=3] [tkas-per-lane=100] [--dry-run]",
      "",
      "status    print lane balances/ages; exit 0 healthy, 1 refill recommended",
      "--dry-run print what a refill would send without submitting anything",
    ].join("\n"),
  );
  process.exit(1);
}

const redeem = Uint8Array.from(DRIP_REDEEM_HEX.match(/../g).map((h) => parseInt(h, 16)));
const dispenser = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(redeem), NETWORK_TYPE);
console.log(`dispenser address: ${dispenser.toString()}`);

const rpc = process.env.KASPA_RPC_URL
  ? new kaspa.RpcClient({ url: process.env.KASPA_RPC_URL, networkId: NETWORK_ID })
  : new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: NETWORK_ID });
await rpc.connect();
console.log(`network: ${NETWORK_ID}, node: ${rpc.url ?? process.env.KASPA_RPC_URL ?? "(resolver)"}`);

if (command === "status") {
  await status();
} else {
  await refill(command, rest[0], rest[1]);
}
await rpc.disconnect();
process.exit(0);

function tkas(sompi) {
  return `${(Number(sompi) / 1e8).toFixed(2)} TKAS`;
}

function amountOf(e) {
  return BigInt(e.amount ?? e.entry?.amount ?? e.utxoEntry?.amount ?? 0n);
}

function bornOf(e) {
  return BigInt(e.blockDaaScore ?? e.entry?.blockDaaScore ?? e.utxoEntry?.blockDaaScore ?? 0n);
}

async function status() {
  const [{ entries }, dagInfo] = await Promise.all([
    rpc.getUtxosByAddresses([dispenser.toString()]),
    rpc.getBlockDagInfo(),
  ]);
  const virtualDaa = BigInt(dagInfo.virtualDaaScore);

  const lanes = entries
    .map((e) => {
      const value = amountOf(e);
      const age = virtualDaa - bornOf(e);
      return { value, age, eligible: age >= COOLDOWN_DAA && value > DUST };
    })
    .sort((a, b) => (b.value > a.value ? 1 : -1));

  const total = lanes.reduce((sum, l) => sum + l.value, 0n);
  const eligible = lanes.filter((l) => l.eligible).length;

  console.log(`total balance: ${tkas(total)} (${total / DRIP_SOMPI} drips) across ${lanes.length} lane(s)`);
  lanes.forEach((l, i) => {
    const state = l.eligible
      ? "eligible now"
      : l.value <= DUST
        ? "dust — unusable"
        : `cooling (${COOLDOWN_DAA - l.age} DAA left)`;
    console.log(`  lane ${i + 1}: ${tkas(l.value)}, age ${l.age} DAA — ${state}`);
  });

  const healthy = eligible >= MIN_ELIGIBLE_LANES && total >= MIN_TOTAL_DRIPS * DRIP_SOMPI;
  if (healthy) {
    console.log(`${eligible} lane(s) eligible, ${total / DRIP_SOMPI} drips of float — healthy`);
    return;
  }
  const why =
    eligible < MIN_ELIGIBLE_LANES
      ? `${eligible} lane(s) eligible (< ${MIN_ELIGIBLE_LANES})`
      : `balance below ${MIN_TOTAL_DRIPS} drips`;
  console.log(`${why} — refill recommended`);
  console.log(`  node fund-dispenser.mjs <keyfile>  # or plain-send TKAS to the address above`);
  await rpc.disconnect();
  process.exit(1);
}

async function refill(keyFile, lanesArg, tkasArg) {
  const lanes = Number(lanesArg ?? 3);
  const perLane = BigInt(Math.round(Number(tkasArg ?? 100) * 1e8));

  const key = new kaspa.PrivateKey(fs.readFileSync(keyFile, "utf8").trim());
  const from = key.toAddress(NETWORK_TYPE);

  const { entries } = await rpc.getUtxosByAddresses([from.toString()]);
  // Freshly mined coins can't be spent until the coinbase matures, and the
  // localnet miner pays this key directly — without the filter the SDK
  // happily builds a transaction the node then rejects.
  const COINBASE_MATURITY = 1000n;
  const { virtualDaaScore } = await rpc.getBlockDagInfo();
  const spendable = entries.filter((e) => {
    if (!(e.isCoinbase ?? e.entry?.isCoinbase)) return true;
    return BigInt(virtualDaaScore) - bornOf(e) >= COINBASE_MATURITY;
  });
  if (!spendable.length) {
    console.error(`no spendable funds at ${from.toString()} (${entries.length} UTXOs still maturing)`);
    process.exit(1);
  }

  console.log(`plan: ${lanes} lane(s) x ${tkas(perLane)} from ${from.toString()}`);

  const { transactions } = await kaspa.createTransactions({
    entries: spendable,
    outputs: Array.from({ length: lanes }, () => ({ address: dispenser, amount: perLane })),
    changeAddress: from,
    priorityFee: 5_000_000n,
    networkId: NETWORK_ID,
  });

  if (dryRun) {
    console.log(`dry-run: would submit ${transactions.length} transaction(s) — nothing sent`);
    return;
  }

  let submitted = 0;
  for (const pending of transactions) {
    await pending.sign([key]);
    try {
      const txid = await pending.submit(rpc);
      submitted++;
      console.log(`tx ${submitted}/${transactions.length} submitted: ${txid}`);
    } catch (e) {
      console.error(`tx ${submitted + 1}/${transactions.length} FAILED after ${submitted} submitted: ${e}`);
      console.error("run `node fund-dispenser.mjs status` to see what landed before retrying");
      await rpc.disconnect();
      process.exit(1);
    }
  }
  console.log(`funded ${lanes} lane(s) x ${tkas(perLane)}`);
  console.log("lanes become claimable after the cooldown (~2 minutes)");
}
