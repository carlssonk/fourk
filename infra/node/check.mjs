#!/usr/bin/env node
// Health of our own node, the way the app sees it: reachable over wss
// through the tunnel, synced, UTXO-indexed, on the right network, and not
// lagging the public network. Exit 0 healthy, 1 not.
//
//     node infra/node/check.mjs [wss://node.fourk.io]
//
// A failing node costs new sessions ~3s (the app falls back to the public
// resolver) but strands open ones until they reload, so alert on it.

import fs from "node:fs";
import init, * as kaspa from "../../vendor/kaspa-wasm/kaspa.js";

await init({
  module_or_path: fs.readFileSync(new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url)),
});

const NETWORK_ID = "testnet-10";
// ~1 minute of blocks at 10 BPS.
const MAX_LAG_DAA = 600n;

const url = process.argv[2] ?? process.env.KASPA_RPC_URL ?? "wss://node.fourk.io";

async function serverInfo(client, timeoutDuration) {
  await client.connect({ strategy: "fallback", timeoutDuration });
  if (!client.isConnected) throw new Error("unreachable");
  try {
    return await client.getServerInfo();
  } finally {
    await client.disconnect();
  }
}

let info;
try {
  info = await serverInfo(new kaspa.RpcClient({ url, networkId: NETWORK_ID }), 10_000);
} catch (e) {
  console.error(`${url}: ${e?.message ?? e}`);
  process.exit(1);
}

const problems = [];
if (String(info.networkId) !== NETWORK_ID) problems.push(`on ${info.networkId}, not ${NETWORK_ID}`);
if (!info.isSynced) problems.push("not synced");
if (!info.hasUtxoIndex) problems.push("no UTXO index");
const daa = BigInt(info.virtualDaaScore);
console.log(`${url}: ${info.serverVersion}, ${info.networkId}, synced=${info.isSynced}, daa=${daa}`);

// A node can call itself synced while stuck on a stale tip; compare with
// any public node. No answer from the resolver is not our node's fault.
try {
  const ref = await serverInfo(
    new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: NETWORK_ID }),
    15_000,
  );
  const lag = BigInt(ref.virtualDaaScore) - daa;
  console.log(`public reference daa=${ref.virtualDaaScore} (we lag ${lag})`);
  if (lag > MAX_LAG_DAA) problems.push(`${lag} DAA behind the public network`);
} catch (e) {
  console.log(`no public reference (${e?.message ?? e}); lag not checked`);
}

if (problems.length) {
  console.error(`unhealthy: ${problems.join(", ")}`);
  process.exit(1);
}
console.log("healthy");
process.exit(0);
