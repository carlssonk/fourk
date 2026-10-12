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
 * contract has no state and no args), emitted by harness/tests/drip_tests.rs
 * (`cargo test --test drip_tests script_is_tiny -- --nocapture`). They — and
 * so the dispenser address — change whenever contracts/drip.sil or the
 * Silverscript compiler changes: refill the new address afterwards.
 */

import { kaspa } from "./sdk";
import {
  scriptInput,
  scriptOutput,
  submitSpec,
  walletAddress,
  walletBalance,
  type PrivateKey,
  type Rpc,
  type UtxoEntryLike,
} from "./engine";
import { NETWORK_ID, NETWORK_TYPE, fromHex } from "./match";

const DRIP_REDEEM_HEX =
  "7604441891a2876375b3519c6902b0047600050000000001a569b1b9be760400ca9a3ba063b9bf00c378876900c252790400ca9a3b949c6975687551676a68";
// push4(entry dispatch tag) then push63(redeem script) — the P2SH reveal.
const CLAIM_SIGSCRIPT_HEX = "04441891a23f" + DRIP_REDEEM_HEX;

/** Must match COOLDOWN / DRIP in contracts/drip.sil. */
const COOLDOWN_DAA = 1200n;
const DRIP_SOMPI = 1_000_000_000n;

/** Below this, an output is storage-mass-poisoned — never create one.
 * KIP-9 storage mass is C/value per output (C = 10^12), and a transaction
 * over the 500k block limit can never be mined: ~0.02 KAS is the hard
 * floor; this keeps margin. Same value as the engine's DUST. */
const DUST = 3_000_000n;

/** Can a claim on this lane succeed at all? The covenant re-locks exactly
 * balance - DRIP, so a remainder below DUST makes the lane unclaimable
 * (an outsider can plant such lanes; the app must not burn its attempts on
 * them). At or below DRIP the whole lane is swept. */
function claimable(balance: bigint): boolean {
  return balance <= DRIP_SOMPI ? balance > DUST : balance - DRIP_SOMPI >= DUST;
}

function dispenserSpk() {
  return kaspa.payToScriptHashScript(fromHex(DRIP_REDEEM_HEX));
}

/** The dispenser's address on NETWORK_ID — the refill target. */
export function dispenserAddress(): string {
  const addr = kaspa.addressFromScriptPublicKey(dispenserSpk(), NETWORK_TYPE);
  if (!addr) throw new Error("cannot derive dispenser address");
  return addr.toString();
}

/** Lanes one claim tries before giving up. Each attempt is a fresh random
 * lane, so a few cover a lost race or two; trying every lane would only
 * stretch out a failure that isn't about lanes (a node refusing everything). */
const MAX_LANE_ATTEMPTS = 8;

/**
 * Claim one drip to `toAddress`. Tries eligible lanes (aged past the
 * cooldown) in random order, so a race lost on one lane falls through to
 * the next. Random rather than ranked: players arriving together would all
 * pick the same "best" lane, and only one claim per lane can win.
 * Resolves to the claim txid.
 */
export async function claimDrip(rpc: Rpc, toAddress: string): Promise<string> {
  // The dispenser is test-network infrastructure: on mainnet anything sent
  // to its address would be free money for whoever claims first.
  if (NETWORK_ID === "mainnet") throw new Error("FREE_PLAY_UNAVAILABLE");
  const [utxoRes, dagInfo] = await Promise.all([
    rpc.getUtxosByAddresses([dispenserAddress()]),
    rpc.getBlockDagInfo(),
  ]);
  const entries = (utxoRes.entries ?? []) as unknown as UtxoEntryLike[];
  const virtualDaa = BigInt(dagInfo.virtualDaaScore);

  const lanes = shuffled(
    entries.filter((e) => {
      const born = BigInt(e.blockDaaScore ?? e.utxoEntry?.blockDaaScore ?? 0n);
      return virtualDaa - born >= COOLDOWN_DAA && claimable(amountOf(e));
    }),
  );

  if (!lanes.length) {
    throw new Error(entries.length ? "DISPENSER_COOLING" : "DISPENSER_EMPTY");
  }

  let lastError: unknown = null;
  for (const lane of lanes.slice(0, MAX_LANE_ATTEMPTS)) {
    try {
      return await claimFromLane(rpc, lane, toAddress);
    } catch (e) {
      lastError = e; // lost a race or lane-specific rejection — try the next
    }
  }
  throw lastError ?? new Error("DISPENSER_COOLING");
}

/** Fisher-Yates; Math.random is fine — this spreads load, it guards nothing. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function claimFromLane(rpc: Rpc, lane: UtxoEntryLike, toAddress: string): Promise<string> {
  const balance = amountOf(lane);
  const payoutSpk = kaspa.payToAddressScript(new kaspa.Address(toAddress));
  const dispenser = dispenserSpk();

  // The claim is an unsigned pure-script spend, so it rides the covenant
  // builder as a ready-made signature script: the engine runs the dispenser
  // contract here, with the same sequence (age) proof the node will check.
  const { txid } = await submitSpec(rpc, [], (fee) => {
    // The contract pins the re-lock at exactly balance - DRIP (claimable()
    // already filtered lanes whose remainder would be dust).
    const relock = balance > DRIP_SOMPI ? balance - DRIP_SOMPI : 0n;
    const take = balance - relock;
    if (take - fee < DUST) throw new Error("DISPENSER_COOLING"); // lane too small to pay its fee
    return {
      network: NETWORK_ID,
      inputs: [scriptInput(lane, CLAIM_SIGSCRIPT_HEX, String(dispenser.script), COOLDOWN_DAA)],
      outputs:
        relock > 0n
          ? [scriptOutput(dispenser, relock), scriptOutput(payoutSpk, take - fee)]
          : [scriptOutput(payoutSpk, take - fee)],
    };
  });
  return txid;
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
  // A claim can be accepted and still never land: two players on different
  // nodes can each spend the same lane, and the loser's transaction is
  // silently dropped. One such loss is retried on another lane.
  let lost = 0;
  for (let claims = 0; claims < 4;) {
    const before = await walletBalance(rpc, address);
    if (before >= need) return;
    await claimDrip(rpc, address);
    let landed = false;
    for (let i = 0; i < 20 && !landed; i++) {
      await sleep(2000);
      const balance = await walletBalance(rpc, address);
      if (balance >= need) return;
      landed = balance > before; // this claim arrived but we're still short
    }
    if (landed) claims++;
    else if (++lost > 1) throw new Error("SEAT_SETUP_FAILED");
  }
  throw new Error("SEAT_SETUP_FAILED");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function amountOf(entry: UtxoEntryLike): bigint {
  return BigInt((entry.amount ?? entry.utxoEntry?.amount)!);
}
