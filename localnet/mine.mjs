#!/usr/bin/env node
// CPU miner for the private local chain. On simnet (the default) the
// genesis difficulty is the consensus minimum, so the nonce search is
// instant and the delay below sets the pace; on devnet expect a few
// seconds per block. Mines to the faucet key's address by default, so
// faucet/fund-dispenser.mjs has coins to turn into dispenser lanes.
//
//     node mine.mjs [blocks=3000] [payAddress]
//
// A count of 0 mines forever. KASPA_NETWORK_ID / KASPA_RPC_URL override
// the network and node (defaults match localnet/run-node.sh).

import fs from "node:fs";
import init, * as kaspa from "../vendor/kaspa-wasm/kaspa.js";

await init(fs.readFileSync(new URL("../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url)));

const NETWORK_ID = process.env.KASPA_NETWORK_ID ?? "simnet";
const RPC_URL = process.env.KASPA_RPC_URL ?? "ws://127.0.0.1:17510";
// ~10 blocks/s, the real chain's pace; full speed would mint thousands/s.
const BLOCK_DELAY_MS = 100;

const [countArg, addressArg] = process.argv.slice(2);
const target = Number(countArg ?? 3000);
const payAddress =
  addressArg ??
  new kaspa.PrivateKey(
    fs.readFileSync(new URL("../faucet/faucet.key", import.meta.url), "utf8").trim(),
  )
    .toAddress(NETWORK_ID.split("-")[0])
    .toString();

const rpc = new kaspa.RpcClient({ url: RPC_URL, networkId: NETWORK_ID });
await rpc.connect();
console.log(`mining ${target || "forever"} to ${payAddress} on ${NETWORK_ID} via ${RPC_URL}`);

for (let mined = 0; target === 0 || mined < target; ) {
  const { block } = await rpc.getBlockTemplate({ payAddress });
  const pow = new kaspa.PoW(block.header);
  for (let nonce = 0n; ; nonce++) {
    if (pow.checkWork(nonce)[0]) {
      block.header.nonce = nonce;
      break;
    }
  }
  const { report } = await rpc.submitBlock({ block, allowNonDAABlocks: false });
  if (report.type !== "success") throw new Error(`block rejected: ${report.reason}`);
  mined++;
  if (mined % 500 === 0 || mined === target) {
    const info = await rpc.getBlockDagInfo();
    console.log(`${mined} blocks — virtual DAA score ${info.virtualDaaScore}`);
  }
  await new Promise((r) => setTimeout(r, BLOCK_DELAY_MS));
}
await rpc.disconnect();
process.exit(0);
