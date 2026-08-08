/**
 * Mode-free transaction engine for the Fourk covenants, on the kaspa wasm
 * SDK. Everything here is generic over `ModeEngine` — the per-mode strategy
 * that derives scripts, selector tables, and budgets. The engine owns:
 *
 *   - node connection and transient-error resilience
 *   - wallet/UTXO access, funding selection, fee floor
 *   - the placeholder-sign-splice build cycle (sighash ignores sig scripts)
 *   - the four transaction shapes every door is one of:
 *       openCovenant   genesis: wallet funding -> covenant output
 *       continuation   covenant input + funding, pot preserved (+delta)
 *       signedTerminal covenant input only, pot minus fee to the caller
 *       pinnedSplit    covenant input + funding, outputs 0/1 pinned to the
 *                      players at half the pot each (optionally signed)
 *   - spend tracing (discoverSpend) and script tokenizing
 *
 * Which entrypoint exists, what its sig script looks like, and what a
 * successor state is are all mode questions — see shared/modes/.
 */

import { kaspa } from "./sdk";
import { NETWORK_ID, NETWORK_TYPE, fromHex, toHex, type Match, type PlayerProfile } from "./match";
import { decodeProfileBytes, encodeProfileBytes } from "./sharecode";
import type { State } from "./game";
import type { SimulCore } from "../modes/fourk/core";

const SUBNETWORK_ID = "00".repeat(20);
const P2PK_BUDGET = 10;
const DUST = 20_000n;
const MIN_RELAY_FEERATE = 100n;
export const FEE_HEADROOM = 2_000_000n;
const PLACEHOLDER_SIG = new Uint8Array(65);

export type Rpc = InstanceType<typeof kaspa.RpcClient>;
export type PrivateKey = InstanceType<typeof kaspa.PrivateKey>;
type Transaction = InstanceType<typeof kaspa.Transaction>;

/** The per-mode strategy the engine is generic over: how a match snapshot
 * becomes scripts and how its entrypoints are numbered. Implemented by
 * shared/modes/(classic|fourk)/engine.ts; lobby-vs-live actor dispatch lives
 * inside the mode. */
export interface ModeEngine {
  /** Covenant input compute budget (classic 12; fourk 20 — its continuations
   * rebuild the ~4.3 KB successor template in-script). */
  covenantBudget: number;
  /** Redeem script (P2SH preimage) for the snapshot. */
  lockRedeem(m: Match): Uint8Array;
  /** Full entry signature script, hex. `blob` carries 32-byte data args
   * (fourk's commitment hash / reveal salt); modes without them ignore it. */
  sigScript(
    m: Match,
    fn: string,
    sig: Uint8Array | undefined,
    pk: Uint8Array | undefined,
    ints: number[],
    blob?: Uint8Array,
  ): string;
  /** ABI selector table for the snapshot's current phase. */
  selectorTable(m: Match): readonly string[];
}

/** RPC UTXO entries arrive in two shapes depending on the SDK path — read
 * through both rather than trusting either typing. */
export interface UtxoEntryLike {
  address?: unknown;
  amount?: bigint | number | string;
  blockDaaScore?: bigint | number | string;
  covenantId?: string;
  outpoint?: { transactionId: unknown; index?: unknown };
  entry?: {
    address?: unknown;
    covenantId?: string;
    outpoint?: { transactionId: unknown; index?: unknown };
  };
  utxoEntry?: { amount?: bigint | number | string; blockDaaScore?: bigint | number | string };
}

/**
 * Connect to a node. A pinned `url` (a dev/self-hosted node) is a quick
 * probe — one attempt, short timeout, throws on failure — so the caller can
 * fall back to the public resolver, which retries forever.
 *
 * A console "CORS" error against a *.kaspa.stream/red/green/blue host here
 * is almost always a dead resolver seed, not a real CORS problem: healthy
 * seeds serve Access-Control-Allow-Origin, and the SDK shuffles through
 * all of them (plus the retry below re-shuffles) until one answers.
 */
export async function connect(url?: string): Promise<Rpc> {
  const client = url
    ? new kaspa.RpcClient({ url, networkId: NETWORK_ID })
    : new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: NETWORK_ID });
  await client.connect(
    url
      ? { strategy: "fallback", timeoutDuration: 3000 }
      : { strategy: "retry", retryInterval: 2000, timeoutDuration: 12000 },
  );

  // Fallback strategy can resolve without a connection — surface that as the
  // failure it is instead of handing back a dead client.
  if (!client.isConnected) throw new Error(`node ${url} is unreachable`);
  // A pinned node that answers while still syncing (or without --utxoindex,
  // or on the wrong network) would "work" but return empty UTXO sets and
  // reject submits — treat it as not ready so the caller falls back to the
  // public resolver instead.
  if (url) {
    const info: any = await client.getServerInfo();
    if (!info.isSynced || !info.hasUtxoIndex || String(info.networkId) !== NETWORK_ID) {
      const why = !info.isSynced
        ? "still syncing"
        : !info.hasUtxoIndex
          ? "running without the UTXO index"
          : `on ${info.networkId}, not ${NETWORK_ID}`;
      await client.disconnect();
      throw new Error(`node ${url} is ${why}`);
    }
  }
  return client;
}

// --- Transient-error resilience ----------------------------------------------
//
// Public resolver nodes drop long-lived websockets routinely (restarts, idle
// timeouts, balancers). The SDK auto-reconnects, but calls in flight at the
// moment of the drop throw "WebSocket disconnected". Reads are idempotent, so
// they retry transparently; transaction submission gets special handling in
// send() because a lost *response* doesn't mean a lost *transaction*.

const TRANSIENT = /websocket|disconnect|not connected|connection|timed? ?out/i;

export function isTransient(e: unknown): boolean {
  return TRANSIENT.test(String((e as any)?.message ?? e));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isTransient(e)) throw e;
      await sleep(1000 * (i + 1)); // give auto-reconnect time to re-establish
    }
  }
}

// --- Wallet / UTXO access ----------------------------------------------------

export function walletAddress(key: PrivateKey): string {
  return key.toAddress(NETWORK_TYPE).toString();
}

export function walletPubkey(key: PrivateKey): string {
  return kaspa.Keypair.fromPrivateKey(key).xOnlyPublicKey;
}

export async function utxosAt(rpc: Rpc, address: string): Promise<UtxoEntryLike[]> {
  const res = await withRetry(() => rpc.getUtxosByAddresses([address]));
  return (res.entries ?? []) as unknown as UtxoEntryLike[];
}

export function entryAmount(entry: UtxoEntryLike): bigint {
  return BigInt((entry.amount ?? entry.utxoEntry?.amount)!);
}

export function entryTxId(entry: UtxoEntryLike): string {
  const outpoint = entry.outpoint ?? entry.entry?.outpoint;
  return String(outpoint!.transactionId);
}

export async function walletBalance(rpc: Rpc, address: string): Promise<bigint> {
  const entries = await utxosAt(rpc, address);
  return entries.reduce((sum, e) => sum + entryAmount(e), 0n);
}

export function matchSpk(mode: ModeEngine, m: Match) {
  return kaspa.payToScriptHashScript(mode.lockRedeem(m));
}

/** The game address of a match snapshot under `mode`. */
export function matchAddress(mode: ModeEngine, m: Match): string {
  const addr = kaspa.addressFromScriptPublicKey(matchSpk(mode, m), NETWORK_TYPE);
  if (!addr) throw new Error("cannot derive game address");
  return addr.toString();
}

export async function fetchGameUtxo(
  rpc: Rpc,
  mode: ModeEngine,
  match: Match,
): Promise<UtxoEntryLike | null> {
  const entries = await utxosAt(rpc, matchAddress(mode, match));
  return entries.find((e) => entryTxId(e) === match.txid) ?? null;
}

/** Wait until the node's UTXO index reflects a freshly submitted game UTXO.
 * Callers hand the returned Match straight to watchers whose first tick reads
 * "UTXO absent" as "UTXO spent" — if that tick beats block acceptance, a
 * brand-new game looks terminated. Best-effort: on timeout the match is
 * returned anyway and the watchers' fallback poll takes over.
 *
 * `spent` is the predecessor the submitted transaction consumed. The NEXT
 * transition can consume our successor within milliseconds (the opponent's
 * autopilot reveals the moment a commit lands), and a spent successor never
 * shows up in the index — polling for it would blind-wait the full timeout.
 * The index updates atomically per accepted transaction, so once the
 * predecessor is gone the successor has either appeared or been spent
 * onward; in both cases the chain moved past our state and the watcher
 * takes it from here. */
export async function untilIndexed(
  rpc: Rpc,
  mode: ModeEngine,
  match: Match,
  spent?: Match,
): Promise<Match> {
  for (let i = 0; i < 40; i++) {
    if (await fetchGameUtxo(rpc, mode, match)) break;
    if (spent && !(await fetchGameUtxo(rpc, mode, spent))) break;
    await sleep(500);
  }
  return match;
}

/** Select wallet UTXOs, largest first, until their sum covers `need`.
 * `need` includes FEE_HEADROOM, generous enough to absorb the extra fee mass
 * of combining several small UTXOs into one spend. */
async function pickFunding(rpc: Rpc, key: PrivateKey, need: bigint): Promise<UtxoEntryLike[]> {
  const entries = await utxosAt(rpc, walletAddress(key));
  if (!entries.length) throw new Error("wallet has no UTXOs — fund it with testnet KAS first");
  const sorted = entries.sort((a, b) => (entryAmount(b) > entryAmount(a) ? 1 : -1));
  const picked: UtxoEntryLike[] = [];
  let total = 0n;
  for (const entry of sorted) {
    picked.push(entry);
    total += entryAmount(entry);
    if (total >= need) return picked;
  }
  throw new Error(`wallet balance (${total} sompi) cannot cover ${need} sompi`);
}

function fundingTotal(entries: UtxoEntryLike[]): bigint {
  return entries.reduce((sum, e) => sum + entryAmount(e), 0n);
}

// --- Transaction assembly ----------------------------------------------------

function gameInput(
  match: Match,
  gameUtxo: UtxoEntryLike,
  sigScriptHex: string,
  budget: number,
  sequence = 0n,
) {
  return new kaspa.TransactionInput({
    previousOutpoint: { transactionId: match.txid, index: 0 },
    signatureScript: sigScriptHex,
    sequence,
    sigOpCount: 0,
    computeBudget: budget,
    utxo: gameUtxo,
  } as any);
}

function fundingInput(entry: UtxoEntryLike, sigScriptHex: string) {
  const outpoint = (entry.outpoint ?? entry.entry?.outpoint)!;
  return new kaspa.TransactionInput({
    previousOutpoint: {
      transactionId: String(outpoint.transactionId),
      index: Number(outpoint.index),
    },
    signatureScript: sigScriptHex,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: P2PK_BUDGET,
    utxo: entry,
  } as any);
}

function makeTx(inputs: any[], outputs: any[], payload = "", lockTime = 0n): Transaction {
  return new kaspa.Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime,
    gas: 0n,
    payload,
    subnetworkId: SUBNETWORK_ID,
  } as any);
}

// The join transaction's payload is the only P2 -> P1 channel that exists
// without a backend: it carries the joiner's profile (name + avatar code),
// and P1's watcher reads it back out of the discovered join tx. Magic-tagged
// so anything else in a payload is ignored, not misparsed.
const PROFILE_PAYLOAD_MAGIC = "346b7031"; // "4kp1"

export function profilePayloadHex(profile: PlayerProfile | undefined): string {
  if (!profile?.name) return "";
  return PROFILE_PAYLOAD_MAGIC + toHex(encodeProfileBytes(profile));
}

export function profileFromPayload(payloadHex: string): PlayerProfile | null {
  if (!payloadHex.startsWith(PROFILE_PAYLOAD_MAGIC)) return null;
  try {
    const buf = fromHex(payloadHex.slice(PROFILE_PAYLOAD_MAGIC.length));
    const p = decodeProfileBytes(buf, { p: 0 });
    return p.name ? p : null;
  } catch {
    return null;
  }
}

function p2pkOutput(pkHex: string, value: bigint) {
  const script = fromHex("20" + pkHex + "ac");
  return new kaspa.TransactionOutput(value, new kaspa.ScriptPublicKey(0, script));
}

function withChange(outputs: any[], changeSpk: any, changeValue: bigint): any[] {
  if (changeValue < 0n) throw new Error(`insufficient funds: short ${-changeValue} sompi`);
  if (changeValue >= DUST) return [...outputs, new kaspa.TransactionOutput(changeValue, changeSpk)];
  return outputs;
}

/** Consensus transaction_estimated_serialized_size, for the transient fee floor. */
function estimatedSize(tx: Transaction): number {
  let size = 94 + String((tx as any).payload ?? "").length / 2;
  for (const input of tx.inputs) size += 54 + String(input.signatureScript).length / 2;
  for (const output of tx.outputs) {
    size += 18 + String(output.scriptPublicKey.script).length / 2;
    if (output.covenant) size += 34;
  }
  return size;
}

/**
 * The mempool fee floor charges max(compute mass, normalized transient mass).
 * The SDK's calculateTransactionMass slightly undercounts consensus compute
 * mass (the +2 spk version bytes per output, at 10 grams/byte), so compute
 * the consensus formula directly and take the max of all three.
 */
export function feeMassFloor(tx: Transaction, sdkMass: bigint): bigint {
  const size = estimatedSize(tx);
  let computeMass = size;
  for (const output of tx.outputs)
    computeMass += (String(output.scriptPublicKey.script).length / 2 + 2) * 10;
  for (const input of tx.inputs) computeMass += Number((input as any).computeBudget ?? 0) * 100;
  return bigMax(bigMax(sdkMass, BigInt(computeMass)), BigInt(size) * 2n);
}

type Build = (fee: bigint, sigs: Map<number, Uint8Array>) => Transaction;

async function send(rpc: Rpc, build: Build, signers: Array<[number, PrivateKey]>): Promise<string> {
  const placeholders = new Map(signers.map(([i]) => [i, PLACEHOLDER_SIG]));
  const draft = build(0n, placeholders);
  const mass = BigInt(kaspa.calculateTransactionMass(NETWORK_ID, draft as any));
  const feeMass = feeMassFloor(draft, mass);
  const estimate: any = await withRetry(() => rpc.getFeeEstimate({} as any));
  const feerate = bigMax(
    BigInt(Math.ceil(Number(estimate.estimate.priorityBucket.feerate))),
    MIN_RELAY_FEERATE,
  );
  const fee = feeMass * feerate;

  const unsigned = build(fee, placeholders);
  const sigs = new Map(
    signers.map(([i, key]) => {
      // createInputSignature returns hex of [push65, 64-byte sig, hashtype];
      // strip the push opcode — the entry sigscript does its own pushing.
      const hex = kaspa.createInputSignature(unsigned as any, i, key);
      return [i, fromHex(hex.slice(2))] as const;
    }),
  );
  const final = build(fee, sigs);
  try {
    const res = await rpc.submitTransaction({ transaction: final as any, allowOrphan: false });
    return String(res.transactionId);
  } catch (e) {
    // A dropped websocket may have eaten the RESPONSE, not the transaction.
    // Resubmit the identical tx once; "already known" then means success.
    if (!isTransient(e)) throw e;
    await sleep(2500);
    try {
      const res = await rpc.submitTransaction({ transaction: final as any, allowOrphan: false });
      return String(res.transactionId);
    } catch (e2: any) {
      if (/already/i.test(String(e2?.message ?? e2))) return String((final as any).id);
      throw e2;
    }
  }
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function fullP2pkSigScript(sig: Uint8Array): string {
  return "41" + toHex(sig);
}

/**
 * Plain wallet send — cash-outs and retired-key sweeps. A fixed `amount`
 * arrives exactly, fee paid from change; `"all"` sweeps every UTXO into one
 * output with the fee taken out of it, leaving the wallet empty.
 */
export async function sendTo(
  rpc: Rpc,
  key: PrivateKey,
  dest: string,
  amount: bigint | "all",
): Promise<{ txid: string; amount: bigint }> {
  const myPrefix = walletAddress(key).split(":")[0]!;
  if (!kaspa.Address.validate(dest) || new kaspa.Address(dest).prefix !== myPrefix)
    throw new Error("BAD_ADDRESS");
  const destSpk = kaspa.payToAddressScript(new kaspa.Address(dest));

  const sweep = amount === "all";
  if (!sweep && amount < DUST) throw new Error("LOW_BALANCE");
  const funding = sweep
    ? await utxosAt(rpc, walletAddress(key))
    : await pickFunding(rpc, key, amount + FEE_HEADROOM);
  const total = fundingTotal(funding);
  if (sweep && total < DUST) throw new Error("LOW_BALANCE");
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));

  let sent = 0n;
  const build: Build = (fee, sigs) => {
    sent = sweep ? total - fee : (amount as bigint);
    if (sent < DUST) throw new Error("LOW_BALANCE"); // fee ate the sweep
    const inputs = funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i)!)));
    const outputs = sweep
      ? [new kaspa.TransactionOutput(sent, destSpk)]
      : withChange([new kaspa.TransactionOutput(sent, destSpk)], changeSpk, total - sent - fee);
    return makeTx(inputs, outputs);
  };

  const txid = await send(
    rpc,
    build,
    funding.map((_, i): [number, PrivateKey] => [i, key]),
  );
  return { txid, amount: sent };
}

// --- The four door shapes -----------------------------------------------------

export interface MatchTiming {
  /** Per-move forfeit clock, DAA blocks (>= contract floor of 600). */
  moveTimeout: number;
  /** Total game duration, DAA blocks; 0 = uncapped. Converted to an
   * absolute sudden-death deadline off the chain's current DAA score. */
  totalCap: number;
}

/** Genesis: fund a fresh covenant output of `stake` at the mode-derived
 * address for `genesis`. Returns the covenant id and txid. */
export async function openCovenant(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  genesis: Match,
): Promise<{ covenantId: string; txid: string }> {
  const stake = genesis.value;
  const spk = matchSpk(mode, genesis);
  const funding = await pickFunding(rpc, key, stake + FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  let covenantId = "";

  const build: Build = (fee, sigs) => {
    const inputs = funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i)!)));
    const outputs = withChange(
      [new kaspa.TransactionOutput(stake, spk)],
      changeSpk,
      fundingTotal(funding) - stake - fee,
    );
    const tx = makeTx(inputs, outputs);
    tx.populateGenesisCovenants([new kaspa.GenesisCovenantGroup(0, [0])]);
    covenantId = String((tx.outputs[0] as any).covenant.covenantId);
    return tx;
  };

  const txid = await send(
    rpc,
    build,
    funding.map((_, i): [number, PrivateKey] => [i, key]),
  );
  return { covenantId, txid };
}

/** Continuation spend (join / move / commit / reveal / resolve): game input
 * + funding, pot preserved (+delta on join). `next` is the successor
 * snapshot; mode-specific Match fields ride along. */
export async function continuation(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  fn: string,
  callArgs: (sig: Uint8Array) => { pk?: Uint8Array; ints: number[]; blob?: Uint8Array },
  next: { state: State; simul?: SimulCore },
  potDelta: bigint,
  payload = "",
): Promise<Match> {
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, potDelta + FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const nextValue = match.value + potDelta;
  const nextMatch: Match = {
    ...match,
    state: next.state,
    ...(next.simul && { simul: next.simul }),
    value: nextValue,
  };

  const build: Build = (fee, sigs) => {
    const { pk, ints, blob } = callArgs(sigs.get(0)!);
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        mode.sigScript(match, fn, sigs.get(0)!, pk, ints, blob),
        mode.covenantBudget,
      ),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    // The TransactionOutput constructor CONSUMES the CovenantBinding wasm
    // object (passed by value into Rust) — it must be constructed fresh on
    // every build, or the signed/submitted rebuilds silently lose the
    // binding and the covenant's OpAuthOutputCount check fails on-chain.
    const binding = new kaspa.CovenantBinding(0, new kaspa.Hash(match.covenantId));
    const outputs = withChange(
      [new kaspa.TransactionOutput(nextValue, matchSpk(mode, nextMatch), binding)],
      changeSpk,
      fundingTotal(funding) - potDelta - fee,
    );
    return makeTx(inputs, outputs, payload);
  };

  const txid = await send(rpc, build, [
    [0, key],
    ...funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  ]);
  return untilIndexed(rpc, mode, { ...nextMatch, txid }, match);
}

/** Signed terminal door (cancel / winning_move / claim_forfeit / claim_win /
 * claim_timeout): pot minus fee to the caller, who signs and directs freely. */
export async function signedTerminal(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  fn: string,
  ints: number[],
  sequence = 0n,
): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const payoutSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        mode.sigScript(match, fn, sigs.get(0)!, undefined, ints),
        mode.covenantBudget,
        sequence,
      ),
    ];
    return makeTx(inputs, [new kaspa.TransactionOutput(match.value - fee, payoutSpk)]);
  };

  return send(rpc, build, [[0, key]]);
}

/** Pinned-split door (claim_draw / sudden_death / claim_split / split_timeout
 * / dissolve): outputs 0/1 pinned to the players at half the pot each, fees
 * on a funding input. `signerPk` makes it a signed door (dissolve);
 * `awaitRefund` waits until the caller's refund is indexed (a kick chains
 * straight into hosting a fresh game off the same UTXO set). */
export async function pinnedSplit(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  fn: string,
  ints: number[],
  opts: { sequence?: bigint; lockTime?: bigint; signerPk?: Uint8Array; awaitRefund?: boolean } = {},
): Promise<string> {
  const { sequence = 0n, lockTime = 0n, signerPk, awaitRefund = false } = opts;
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const half = match.value / 2n;

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        mode.sigScript(match, fn, signerPk ? sigs.get(0)! : undefined, signerPk, ints),
        mode.covenantBudget,
        sequence,
      ),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    const outputs = withChange(
      [p2pkOutput(match.state.p1, half), p2pkOutput(match.state.p2, half)],
      changeSpk,
      fundingTotal(funding) - fee,
    );
    return makeTx(inputs, outputs, "", lockTime);
  };

  const signers: Array<[number, PrivateKey]> = [
    ...(signerPk ? ([[0, key]] as Array<[number, PrivateKey]>) : []),
    ...funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  ];
  const txid = await send(rpc, build, signers);

  if (awaitRefund) {
    // Wait until the index reflects this spend (our refund appearing means
    // the consumed inputs are gone; both update atomically), or a follow-up
    // rebuilds on stale UTXOs and bounces off the node as an orphan.
    const mine = walletAddress(key);
    for (let i = 0; i < 20; i++) {
      const entries = await utxosAt(rpc, mine);
      if (entries.some((e) => entryTxId(e) === txid)) break;
      await sleep(500);
    }
  }
  return txid;
}

// --- Spend tracing ------------------------------------------------------------

/** A recent chain block hash, captured while waiting so a later spend of the
 * game UTXO can be traced through getBlocks. */
export async function chainCheckpoint(rpc: Rpc): Promise<string> {
  const info: any = await withRetry(() => rpc.getBlockDagInfo());
  return String(info.sink);
}

export interface SpendInfo {
  kind: string;
  txid: string;
  /** Data pushes of the entry call (sig, pk — selector and redeem excluded). */
  pushes: Uint8Array[];
  /** Small-integer arguments of the entry call, in declared order (e.g. the
   * played column leads winning_move's [col, wcol, wrow, wdir]). Data pushes
   * like the signature don't appear here. */
  args: number[];
  /** The spending transaction's payload, hex (profile channel on joins). */
  payload: string;
}

/**
 * Find the transaction that spent the current game UTXO in blocks since
 * `lowHash` and classify which covenant entrypoint it called (the function
 * selector sits directly before the pushed redeem script; `table` is the
 * mode's ABI order for the match's phase). Pages through getBlocks up to the
 * tip — a backgrounded tab can wake hours past its checkpoint. Returns null
 * if the spend is outside the scanned window; throws if `lowHash` is unknown
 * to the node (e.g. pruned).
 */
export async function discoverSpend(
  rpc: Rpc,
  match: Match,
  lowHash: string,
  table: readonly string[],
): Promise<SpendInfo | null> {
  let low = lowHash;
  for (let page = 0; page < 50; page++) {
    const res: any = await withRetry(() =>
      rpc.getBlocks({ lowHash: low, includeBlocks: true, includeTransactions: true }),
    );
    for (const block of res.blocks ?? []) {
      for (const tx of block.transactions ?? []) {
        for (const inp of tx.inputs ?? []) {
          const outpoint = inp?.previousOutpoint ?? inp?.previous_outpoint;
          if (
            !outpoint ||
            String(outpoint.transactionId) !== match.txid ||
            Number(outpoint.index ?? 0) !== 0
          )
            continue;
          const tokens = scriptTokens(String(inp.signatureScript ?? inp.signature_script ?? ""));
          const selector = tokens.length >= 2 ? tokenToSmallInt(tokens[tokens.length - 2]!) : null;
          const kind = selector !== null ? table[selector] : undefined;
          if (!kind) return null;
          const call = tokens.slice(0, Math.max(0, tokens.length - 2));
          return {
            kind,
            txid: String(tx.verboseData?.transactionId ?? tx.verbose_data?.transaction_id ?? ""),
            pushes: call.filter((t) => t.data !== null).map((t) => t.data!),
            args: call.map(tokenToSmallInt).filter((v): v is number => v !== null),
            payload: String(tx.payload ?? ""),
          };
        }
      }
    }
    const hashes: unknown[] = res.blockHashes ?? res.block_hashes ?? [];
    const next = hashes.length ? String(hashes[hashes.length - 1]) : "";
    // The page ends where it started: we've reached the tip.
    if (!next || next === low) return null;
    low = next;
  }
  return null;
}

interface ScriptToken {
  op: number;
  data: Uint8Array | null;
}

/** Tokenize a signature script into opcodes and their pushed data. */
function scriptTokens(hex: string): ScriptToken[] {
  const b = fromHex(hex);
  const out: ScriptToken[] = [];
  let i = 0;
  while (i < b.length) {
    const op = b[i++]!;
    let len = -1;
    if (op <= 0x4b) len = op;
    else if (op === 0x4c) {
      len = b[i]!;
      i += 1;
    } else if (op === 0x4d) {
      len = b[i]! | (b[i + 1]! << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
      i += 4;
    }
    if (len >= 0) {
      out.push({ op, data: b.slice(i, i + len) });
      i += len;
    } else {
      out.push({ op, data: null });
    }
  }
  return out;
}

/** Decode a minimally-encoded small integer token (OP_0/OP_1..16/1-byte push). */
function tokenToSmallInt(t: ScriptToken): number | null {
  if (t.op === 0x00) return 0;
  if (t.op >= 0x51 && t.op <= 0x60) return t.op - 0x50;
  if (t.data && t.data.length === 1) return t.data[0]!;
  if (t.data && t.data.length === 0) return 0;
  return null;
}

/** DAA-block age of the current game UTXO, for the forfeit countdown. */
export async function gameUtxoAge(
  rpc: Rpc,
  mode: ModeEngine,
  match: Match,
): Promise<number | null> {
  const entry = await fetchGameUtxo(rpc, mode, match);
  if (!entry) return null;
  const daaScore = BigInt(entry.blockDaaScore ?? entry.utxoEntry?.blockDaaScore ?? 0n);
  const info: any = await withRetry(() => rpc.getBlockDagInfo());
  return Number(BigInt(info.virtualDaaScore) - daaScore);
}

export function myRole(match: Match, pkHex: string): "p1" | "p2" | "spectator" {
  if (match.state.p1 === pkHex) return "p1";
  if (match.state.p2 === pkHex) return "p2";
  return "spectator";
}
