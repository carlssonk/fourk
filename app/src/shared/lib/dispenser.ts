/**
 * On-chain dispenser claims — free mode's funding with no backend at all.
 *
 * contracts/drip.sil is a stateless covenant: its address never changes, and
 * a claim is an UNSIGNED pure-script spend — one dispenser input, output 0
 * re-locking balance-minus-drip to the same script, the remainder (minus
 * fee, paid out of the drip) to the new player. A wallet with zero funds can
 * claim; refilling is just sending TKAS to the address (each send becomes an
 * independent drip lane on its own cooldown).
 *
 * The redeem script and claim sigscript are compile-time constants (the
 * contract has no state and no args), emitted by harness/tests/drip_tests.rs.
 */

import { kaspa } from "./sdk";
import {
  feeMassFloor,
  walletAddress,
  walletBalance,
  type PrivateKey,
  type Rpc,
  type UtxoEntryLike,
} from "./engine";
import { NETWORK_ID, NETWORK_TYPE, fromHex } from "./match";

const DRIP_REDEEM_HEX =
  "b3519c6902b004b1b9be760400ca9a3ba06300c3b9bf876900c2780400ca9a3b94a26968007a7551";
const CLAIM_SIGSCRIPT_HEX = "28" + DRIP_REDEEM_HEX;

/** Must match COOLDOWN / DRIP in contracts/drip.sil. */
const COOLDOWN_DAA = 1200n;
const DRIP_SOMPI = 1_000_000_000n;

const MIN_RELAY_FEERATE = 100n;
const SUBNETWORK_ID = "00".repeat(20);
/** Below this, an output is storage-mass-poisoned — never create one. */
const DUST = 20_000n;

function dispenserSpk() {
  return kaspa.payToScriptHashScript(fromHex(DRIP_REDEEM_HEX));
}

function dispenserAddress(): string {
  const addr = kaspa.addressFromScriptPublicKey(dispenserSpk(), NETWORK_TYPE);
  if (!addr) throw new Error("cannot derive dispenser address");
  return addr.toString();
}

/**
 * Claim one drip to `toAddress`. Tries every eligible lane (aged past the
 * cooldown, largest first) so a race lost on one lane falls through to the
 * next. Resolves to the claim txid.
 */
export async function claimDrip(rpc: Rpc, toAddress: string): Promise<string> {
  const [utxoRes, dagInfo, feeRes] = await Promise.all([
    rpc.getUtxosByAddresses([dispenserAddress()]),
    rpc.getBlockDagInfo(),
    rpc.getFeeEstimate({}),
  ]);
  const entries = (utxoRes.entries ?? []) as unknown as UtxoEntryLike[];
  const virtualDaa = BigInt(dagInfo.virtualDaaScore);
  const feerate = bigMax(
    BigInt(Math.ceil(Number(feeRes.estimate.priorityBucket.feerate))),
    MIN_RELAY_FEERATE,
  );

  const lanes = entries
    .filter((e) => {
      const born = BigInt(e.blockDaaScore ?? e.utxoEntry?.blockDaaScore ?? 0n);
      return virtualDaa - born >= COOLDOWN_DAA;
    })
    .sort((a, b) => (amountOf(b) > amountOf(a) ? 1 : -1));

  if (!lanes.length) {
    throw new Error(entries.length ? "DISPENSER_COOLING" : "DISPENSER_EMPTY");
  }

  let lastError: unknown = null;
  for (const lane of lanes.slice(0, 3)) {
    try {
      return await claimFromLane(rpc, lane, toAddress, feerate);
    } catch (e) {
      lastError = e; // lost a race or lane-specific rejection — try the next
    }
  }
  throw lastError ?? new Error("DISPENSER_COOLING");
}

async function claimFromLane(
  rpc: Rpc,
  lane: UtxoEntryLike,
  toAddress: string,
  feerate: bigint,
): Promise<string> {
  const balance = amountOf(lane);
  const outpoint = (lane.outpoint ?? lane.entry?.outpoint)!;
  const input = new kaspa.TransactionInput({
    previousOutpoint: {
      transactionId: String(outpoint.transactionId),
      index: Number(outpoint.index),
    },
    signatureScript: CLAIM_SIGSCRIPT_HEX,
    sequence: COOLDOWN_DAA,
    sigOpCount: 0,
    computeBudget: 1,
    utxo: lane,
  } as any);
  const payoutSpk = kaspa.payToAddressScript(new kaspa.Address(toAddress));

  const build = (fee: bigint) => {
    // The contract pins the re-lock at >= balance - DRIP, so a lane whose
    // remainder would be dust can re-lock a little extra (shrinking this
    // claim) instead of creating a poisoned tail UTXO nobody can sweep.
    const relock = balance > DRIP_SOMPI ? bigMax(balance - DRIP_SOMPI, DUST) : 0n;
    const take = balance - relock;
    if (take - fee < DUST) throw new Error("DISPENSER_COOLING"); // lane too small to pay its fee
    const outputs =
      relock > 0n
        ? [
            new kaspa.TransactionOutput(relock, dispenserSpk()),
            new kaspa.TransactionOutput(take - fee, payoutSpk),
          ]
        : [new kaspa.TransactionOutput(take - fee, payoutSpk)];
    return new kaspa.Transaction({
      version: 1,
      inputs: [input],
      outputs,
      lockTime: 0n,
      gas: 0n,
      payload: "",
      subnetworkId: SUBNETWORK_ID,
    } as any);
  };

  const draft = build(0n);
  const mass = BigInt(kaspa.calculateTransactionMass(NETWORK_ID, draft as any));
  const fee = feeMassFloor(draft, mass) * feerate;

  const res = await rpc.submitTransaction({ transaction: build(fee) as any, allowOrphan: false });
  return String(res.transactionId);
}

/**
 * Top the wallet up from the dispenser until its balance covers `need`,
 * waiting for each claim to land. Resolves immediately if it already does.
 * One drip may not cover a large stake (a CLI-hosted invite can carry any
 * amount), so this claims lane after lane until the balance is there — or
 * the dispenser runs out of eligible lanes and the claim itself throws.
 *
 * Staked games never drip: the player's own balance is the whole point, so
 * a shortfall is a "add funds" moment (LOW_BALANCE), not a top-up.
 */
export async function ensureFunds(
  rpc: Rpc,
  key: PrivateKey,
  need: bigint,
  opts: { staked?: boolean } = {},
): Promise<void> {
  const address = walletAddress(key);
  if (opts.staked) {
    if ((await walletBalance(rpc, address)) < need) throw new Error("LOW_BALANCE");
    return;
  }
  for (let claims = 0; claims < 4; claims++) {
    const before = await walletBalance(rpc, address);
    if (before >= need) return;
    await claimDrip(rpc, address);
    let landed = false;
    for (let i = 0; i < 20 && !landed; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const balance = await walletBalance(rpc, address);
      if (balance >= need) return;
      landed = balance > before; // this claim arrived but we're still short
    }
    if (!landed) throw new Error("SEAT_SETUP_FAILED");
  }
  throw new Error("SEAT_SETUP_FAILED");
}

function amountOf(entry: UtxoEntryLike): bigint {
  return BigInt((entry.amount ?? entry.utxoEntry?.amount)!);
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
