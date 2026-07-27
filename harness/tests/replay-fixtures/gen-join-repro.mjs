// Rebuild the browser app's join transaction offline, exactly as
// app/src/lib/covenant.ts does, against fixed fixtures — then dump it as JSON
// for the Rust harness to replay through the real script engine.
//
// Run:  node gen-join-repro.mjs  (from this directory)

import fs from "fs";
import { createRequire } from "module";
const here = new URL(".", import.meta.url).pathname;

import kaspaInit, * as kaspa from "../../../vendor/kaspa-wasm/kaspa.js";
import fourkInit, * as fourk from "../../../wasm/pkg/fourk_wasm.js";

await kaspaInit(fs.readFileSync(new URL("../../../vendor/kaspa-wasm/kaspa_bg.wasm", import.meta.url)));
await fourkInit(fs.readFileSync(new URL("../../../wasm/pkg/fourk_wasm_bg.wasm", import.meta.url)));

const NETWORK_TYPE = "testnet";
const SUBNETWORK_ID = "00".repeat(20);
const COVENANT_BUDGET = 12;
const P2PK_BUDGET = 10;

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// --- fixtures ---------------------------------------------------------------
const key1 = new kaspa.PrivateKey("01".padStart(64, "0"));
const key2 = new kaspa.PrivateKey("02".padStart(64, "0"));
const pk1 = kaspa.Keypair.fromPrivateKey(key1).xOnlyPublicKey;
const pk2 = kaspa.Keypair.fromPrivateKey(key2).xOnlyPublicKey;

const STAKE = 100_000_000n;
const GENESIS_TXID = "cd".repeat(32);
const COVENANT_ID = "ab".repeat(32);
const FUNDING_TXID = "ef".repeat(32);
const FUNDING_AMOUNT = 500_000_000n;
const FEE = 1_000_000n;

const openState = { p1: pk1, p2: "0".repeat(64), board: new Uint8Array(42), moveCount: 0, moveTimeout: 36000, deadline: 0 };
const nextState = { ...openState, p2: pk2 };

// --- app logic, replicated verbatim ----------------------------------------
const phaseOf = (s) => (s.p2 === "0".repeat(64) ? 0 : 1);
const stateArgs = (s) => [fromHex(s.p1), fromHex(s.p2), s.board, BigInt(s.moveCount), BigInt(phaseOf(s)), BigInt(s.moveTimeout), BigInt(s.deadline)];
const lockRedeem = (s) => fourk.lockScript(...stateArgs(s));
const gameSpk = (s) => kaspa.payToScriptHashScript(lockRedeem(s));

const entrySigScript = (s, fn, sig, pk, ints) =>
  toHex(fourk.sigScript(...stateArgs(s), fn, sig, pk, ints?.length ? BigInt64Array.from(ints.map(BigInt)) : undefined));

const gameAddr = kaspa.addressFromScriptPublicKey(gameSpk(openState), NETWORK_TYPE).toString();
const fundingSpk = kaspa.payToAddressScript(key2.toAddress(NETWORK_TYPE));

const gameUtxo = {
  address: gameAddr,
  outpoint: { transactionId: GENESIS_TXID, index: 0 },
  utxoEntry: {
    amount: STAKE,
    scriptPublicKey: gameSpk(openState),
    blockDaaScore: 0n,
    isCoinbase: false,
    covenant_id: COVENANT_ID,
    covenantId: COVENANT_ID,
  },
};
const fundingUtxo = {
  address: key2.toAddress(NETWORK_TYPE).toString(),
  outpoint: { transactionId: FUNDING_TXID, index: 1 },
  utxoEntry: {
    amount: FUNDING_AMOUNT,
    scriptPublicKey: fundingSpk,
    blockDaaScore: 0n,
    isCoinbase: false,
  },
};

const changeSpk = kaspa.payToAddressScript(key2.toAddress(NETWORK_TYPE));

function build(fee, sigs) {
  // Fresh per build — the TransactionOutput constructor consumes it (this
  // reuse bug was the original live failure this fixture reproduces).
  const binding = new kaspa.CovenantBinding(0, new kaspa.Hash(COVENANT_ID));
  const inputs = [
    new kaspa.TransactionInput({
      previousOutpoint: { transactionId: GENESIS_TXID, index: 0 },
      signatureScript: entrySigScript(openState, "join", sigs.get(0), fromHex(pk2), []),
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: COVENANT_BUDGET,
      utxo: gameUtxo,
    }),
    new kaspa.TransactionInput({
      previousOutpoint: { transactionId: FUNDING_TXID, index: 1 },
      signatureScript: "41" + toHex(sigs.get(1)),
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: P2PK_BUDGET,
      utxo: fundingUtxo,
    }),
  ];
  const outputs = [
    new kaspa.TransactionOutput(2n * STAKE, gameSpk(nextState), binding),
    new kaspa.TransactionOutput(FUNDING_AMOUNT - STAKE - fee, changeSpk),
  ];
  return new kaspa.Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime: 0n,
    gas: 0n,
    payload: "",
    subnetworkId: SUBNETWORK_ID,
  });
}

const placeholder = new Map([[0, new Uint8Array(65)], [1, new Uint8Array(65)]]);
const unsigned = build(FEE, placeholder);
const sigs = new Map(
  [0, 1].map((i) => [i, fromHex(kaspa.createInputSignature(unsigned, i, i === 0 ? key2 : key2).slice(2))]),
);
const final = build(FEE, sigs);

// --- dump for the Rust replayer ---------------------------------------------
const dump = {
  version: 1,
  lockTime: 0,
  inputs: final.inputs.map((inp, i) => ({
    transactionId: String(inp.previousOutpoint.transactionId),
    index: Number(inp.previousOutpoint.index),
    signatureScript: String(inp.signatureScript),
    sequence: Number(inp.sequence),
    computeBudget: i === 0 ? COVENANT_BUDGET : P2PK_BUDGET,
    utxoAmount: Number(i === 0 ? STAKE : FUNDING_AMOUNT),
    utxoScript: String(i === 0 ? gameSpk(openState).script : fundingSpk.script),
    utxoCovenantId: i === 0 ? COVENANT_ID : null,
  })),
  outputs: final.outputs.map((out) => ({
    value: Number(out.value),
    script: String(out.scriptPublicKey.script),
    covenant: out.covenant ? { authorizingInput: out.covenant.authorizingInput, covenantId: String(out.covenant.covenantId) } : null,
  })),
};
fs.writeFileSync(new URL("join-repro.json", import.meta.url), JSON.stringify(dump, null, 2));
console.log("wrote join-repro.json");
console.log("output0 covenant:", JSON.stringify(dump.outputs[0].covenant));
console.log("sigscript0 len:", dump.inputs[0].signatureScript.length / 2);
