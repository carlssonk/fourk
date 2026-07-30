#!/usr/bin/env node
// Refill the on-chain dispenser (contracts/drip.sil): send TKAS lanes to its
// fixed address from a funded key. Each output becomes an independent drip
// lane on its own cooldown.
//
//     node fund-dispenser.mjs <keyfile> [lanes=3] [tkas-per-lane=100]

import fs from "node:fs";
import init, * as kaspa from "../vendor/kaspa-wasm/kaspa.js";

await init(fs.readFileSync(new URL("../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url)));

// Keep in sync with contracts/drip.sil — harness/tests/drip_tests.rs prints it.
const DRIP_REDEEM_HEX = "b3519c6902b004b1b9be760400ca9a3ba06300c3b9bf876900c2780400ca9a3b94a26968007a7551";

// Keep in sync with NETWORK_ID / NETWORK_TYPE in app/src/shared/lib/match.ts.
const NETWORK_ID = "testnet-10";
const NETWORK_TYPE = "testnet";

const [keyFile, lanesArg, tkasArg] = process.argv.slice(2);
if (!keyFile) {
  console.error("usage: node fund-dispenser.mjs <keyfile> [lanes=3] [tkas-per-lane=100]");
  process.exit(1);
}
const lanes = Number(lanesArg ?? 3);
const perLane = BigInt(Math.round(Number(tkasArg ?? 100) * 1e8));

const key = new kaspa.PrivateKey(fs.readFileSync(keyFile, "utf8").trim());
const from = key.toAddress(NETWORK_TYPE);
const redeem = Uint8Array.from(DRIP_REDEEM_HEX.match(/../g).map((h) => parseInt(h, 16)));
const dispenser = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(redeem), NETWORK_TYPE);
console.log(`dispenser address: ${dispenser.toString()}`);

const rpc = process.env.KASPA_RPC_URL
  ? new kaspa.RpcClient({ url: process.env.KASPA_RPC_URL, networkId: NETWORK_ID })
  : new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: NETWORK_ID });
await rpc.connect();

const { entries } = await rpc.getUtxosByAddresses([from.toString()]);
if (!entries.length) {
  console.error(`no funds at ${from.toString()}`);
  process.exit(1);
}

const { transactions } = await kaspa.createTransactions({
  entries,
  outputs: Array.from({ length: lanes }, () => ({ address: dispenser, amount: perLane })),
  changeAddress: from,
  priorityFee: 5_000_000n,
  networkId: NETWORK_ID,
});
for (const pending of transactions) {
  await pending.sign([key]);
  console.log(`funded ${lanes} lane(s) x ${perLane} sompi: ${await pending.submit(rpc)}`);
}
console.log("lanes become claimable after the cooldown (~2 minutes)");
await rpc.disconnect();
process.exit(0);
