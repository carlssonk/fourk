// Local simnet fixtures only: never connect to a public network or resolver.
import fs from "node:fs";
import init, * as kaspa from "kaspa-wasm";

let ready;
export async function fundAccount(address) {
  if (!address.startsWith("kaspasim:")) throw new Error("Playtests fund simnet addresses only");
  await (ready ??= init({
    module_or_path: fs.readFileSync(
      new URL("../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url),
    ),
  }));
  const rpc = new kaspa.RpcClient({ url: "ws://127.0.0.1:17510", networkId: "simnet" });
  await rpc.connect();
  try {
    const info = await rpc.getServerInfo();
    if (String(info.networkId) !== "simnet") throw new Error("Expected a local simnet node");
    const key = new kaspa.PrivateKey(
      fs.readFileSync(new URL("../../faucet/faucet.key", import.meta.url), "utf8").trim(),
    );
    const from = key.toAddress("simnet").toString();
    const { entries } = await rpc.getUtxosByAddresses([from]);
    const { virtualDaaScore } = await rpc.getBlockDagInfo();
    const mature = entries.filter(
      (e) =>
        !(e.isCoinbase ?? e.entry?.isCoinbase) ||
        BigInt(virtualDaaScore) - BigInt(e.blockDaaScore ?? e.entry?.blockDaaScore ?? 0) >= 1000n,
    );
    const { transactions } = await kaspa.createTransactions({
      entries: mature,
      outputs: [{ address, amount: 5_000_000_000n }],
      changeAddress: from,
      priorityFee: 5_000_000n,
      networkId: "simnet",
    });
    for (const tx of transactions) {
      await tx.sign([key]);
      await tx.submit(rpc);
    }
  } finally {
    await rpc.disconnect();
  }
}
