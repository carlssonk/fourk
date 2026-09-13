/**
 * Mode-free transaction engine for the Fourk covenants. Every covenant spend
 * is described as a plain JSON spec (inputs, outputs, entry arguments) and
 * handed to fourk-wasm's `buildTransaction`, which signs it, assembles it,
 * and executes every input through the real Kaspa script engine via
 * argent-runtime's TxBuilder — the same builder the Rust harness drives. A
 * malformed spend therefore fails here, with the engine's reason, instead of
 * as an opaque node rejection; compute budgets are measured, not declared.
 *
 * The engine owns:
 *   - node connection and transient-error resilience
 *   - wallet/UTXO access, funding selection, fee sizing (two builds: the
 *     first measures the fee mass, the second carries the fee)
 *   - the door shapes every entrypoint is one of:
 *       openCovenant   genesis: wallet funding -> covenant output
 *       continuation   covenant input + funding, pot preserved (+delta)
 *       signedTerminal covenant input only, pot minus fee to the caller
 *       pinnedWinner   covenant input only, pot minus fee to a pinned winner
 *       pinnedSplit    covenant input only, outputs 0/1 pinned to the players
 *   - spend tracing (discoverSpend)
 *
 * Which actor holds a snapshot and what its state fields are is a mode
 * question (`ModeEngine`, shared/modes/); which arguments a door takes is the
 * caller's (ordered ABI argument lists — the builder checks count and type).
 */

import { fourk, kaspa } from "./sdk";
import { NETWORK_ID, NETWORK_TYPE, fromHex, toHex, type Match, type PlayerProfile } from "./match";
import { decodeProfileBytes, encodeProfileBytes } from "./sharecode";
import type { State } from "./game";
import type { SimulCore } from "../modes/fourk/core";

const DUST = 20_000n;
const MIN_RELAY_FEERATE = 100n;
export const FEE_HEADROOM = 2_000_000n;

export type Rpc = InstanceType<typeof kaspa.RpcClient>;
export type PrivateKey = InstanceType<typeof kaspa.PrivateKey>;

/** An actor's state fields as the wasm builder expects them: hex for
 * byte-like fields, numbers for integers. Field names are the contract's. */
export type ActorState = Record<string, string | number>;

/** The per-mode strategy the engine is generic over: which actor holds a
 * match snapshot and how the snapshot maps onto that actor's state fields.
 * Implemented by shared/modes/(classic|fourk)/engine.ts. */
export interface ModeEngine {
  /** The actor (contract) holding the snapshot: the lobby actor while the
   * seat is open, the live actor afterwards. */
  actorOf(m: Match): string;
  /** The snapshot as that actor's state fields. */
  stateOf(m: Match): ActorState;
}

/** RPC UTXO entries arrive in two shapes depending on the SDK path — read
 * through both rather than trusting either typing. */
export interface UtxoEntryLike {
  address?: unknown;
  amount?: bigint | number | string;
  blockDaaScore?: bigint | number | string;
  isCoinbase?: boolean;
  covenantId?: string;
  outpoint?: { transactionId: unknown; index?: unknown };
  entry?: {
    address?: unknown;
    covenantId?: string;
    isCoinbase?: boolean;
    blockDaaScore?: bigint | number | string;
    outpoint?: { transactionId: unknown; index?: unknown };
  };
  utxoEntry?: {
    amount?: bigint | number | string;
    blockDaaScore?: bigint | number | string;
    isCoinbase?: boolean;
  };
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
// submitSpec() because a lost *response* doesn't mean a lost *transaction*.

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

function entryDaaScore(entry: UtxoEntryLike): bigint {
  return BigInt(
    entry.blockDaaScore ?? entry.entry?.blockDaaScore ?? entry.utxoEntry?.blockDaaScore ?? 0n,
  );
}

function entryIsCoinbase(entry: UtxoEntryLike): boolean {
  return Boolean(
    entry.isCoinbase ?? entry.entry?.isCoinbase ?? entry.utxoEntry?.isCoinbase ?? false,
  );
}

export async function walletBalance(rpc: Rpc, address: string): Promise<bigint> {
  const entries = await utxosAt(rpc, address);
  return entries.reduce((sum, e) => sum + entryAmount(e), 0n);
}

/** The script public key locking a match snapshot under `mode`. */
export function matchSpk(mode: ModeEngine, m: Match) {
  const script = fourk.actorScriptPublicKey(mode.actorOf(m), JSON.stringify(mode.stateOf(m)));
  return new kaspa.ScriptPublicKey(0, script);
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

// --- Transaction specs ---------------------------------------------------------
//
// The JSON the wasm builder consumes (wasm/src/builder.rs documents it).
// Sompi and DAA quantities travel as decimal strings; bytes as hex.

/** One entry argument, in the contract's declared order. `sig` names a
 * signer index into the keys handed to submitSpec. */
export type EntryArg = { sig: number } | { bytes: string } | { int: number };

interface UtxoSpec {
  outpoint: { txid: string; index: number };
  value: string;
  daaScore: string;
  coinbase: boolean;
  sequence: string;
}

type InputSpec =
  | ({
      kind: "actor";
      actor: string;
      state: ActorState;
      entry: string;
      args: EntryArg[];
      covenantId: string;
    } & UtxoSpec)
  | ({ kind: "p2pk"; signer: number; pubkey: string } & UtxoSpec)
  | ({ kind: "script"; sigScript: string; scriptPublicKey: string } & UtxoSpec);

type OutputSpec =
  | {
      kind: "actor";
      actor: string;
      state: ActorState;
      authorizingInput: number;
      covenantId: string;
      value: string;
    }
  | { kind: "genesis"; actor: string; state: ActorState; authorizingInput: number; value: string }
  | { kind: "script"; scriptPublicKey: string; value: string };

export interface TxSpec {
  network: string;
  lockTime?: string;
  payload?: string;
  inputs: InputSpec[];
  outputs: OutputSpec[];
}

/** What the builder hands back: the finished transaction plus its masses. */
export interface BuiltTx {
  id: string;
  version: number;
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payload: string;
  inputs: Array<{
    transactionId: string;
    index: number;
    signatureScript: string;
    sequence: string;
    sigOpCount: number;
    computeBudget: number;
  }>;
  outputs: Array<{
    value: string;
    scriptVersion: number;
    script: string;
    covenant: { authorizingInput: number; covenantId: string } | null;
  }>;
  mass: { compute: string; transient: string; storage: string; fee: string };
}

function utxoSpec(entry: UtxoEntryLike, sequence = 0n): UtxoSpec {
  const outpoint = (entry.outpoint ?? entry.entry?.outpoint)!;
  return {
    outpoint: { txid: String(outpoint.transactionId), index: Number(outpoint.index ?? 0) },
    value: entryAmount(entry).toString(),
    daaScore: entryDaaScore(entry).toString(),
    coinbase: entryIsCoinbase(entry),
    sequence: sequence.toString(),
  };
}

/** The match's covenant UTXO as a spec input calling `entry`. */
export function gameInput(
  mode: ModeEngine,
  match: Match,
  gameUtxo: UtxoEntryLike,
  entry: string,
  args: EntryArg[],
  sequence = 0n,
): InputSpec {
  return {
    kind: "actor",
    actor: mode.actorOf(match),
    state: mode.stateOf(match),
    entry,
    args,
    covenantId: match.covenantId,
    ...utxoSpec(gameUtxo, sequence),
  };
}

/** A wallet UTXO as a spec input signed by key `signer`. */
export function fundingInput(entry: UtxoEntryLike, signer: number, pubkeyHex: string): InputSpec {
  return { kind: "p2pk", signer, pubkey: pubkeyHex, ...utxoSpec(entry) };
}

/** A UTXO spent with a ready-made signature script (the dispenser claim). */
export function scriptInput(
  entry: UtxoEntryLike,
  sigScriptHex: string,
  scriptPublicKeyHex: string,
  sequence = 0n,
): InputSpec {
  return {
    kind: "script",
    sigScript: sigScriptHex,
    scriptPublicKey: scriptPublicKeyHex,
    ...utxoSpec(entry, sequence),
  };
}

/** A plain output to `spk` (an SDK ScriptPublicKey). */
export function scriptOutput(spk: { script: string }, value: bigint): OutputSpec {
  return { kind: "script", scriptPublicKey: String(spk.script), value: value.toString() };
}

export function p2pkOutput(pkHex: string, value: bigint): OutputSpec {
  return { kind: "script", scriptPublicKey: "20" + pkHex + "ac", value: value.toString() };
}

/** The successor covenant output, authorized by input `authorizingInput`. */
function successorOutput(
  mode: ModeEngine,
  next: Match,
  authorizingInput: number,
  value: bigint,
): OutputSpec {
  return {
    kind: "actor",
    actor: mode.actorOf(next),
    state: mode.stateOf(next),
    authorizingInput,
    covenantId: next.covenantId,
    value: value.toString(),
  };
}

function withChange(
  outputs: OutputSpec[],
  changeSpk: { script: string },
  changeValue: bigint,
): OutputSpec[] {
  if (changeValue < 0n) throw new Error(`insufficient funds: short ${-changeValue} sompi`);
  if (changeValue >= DUST) return [...outputs, scriptOutput(changeSpk, changeValue)];
  return outputs;
}

// --- Build / submit ------------------------------------------------------------

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

function secretsOf(keys: PrivateKey[]): Uint8Array {
  const out = new Uint8Array(32 * keys.length);
  keys.forEach((key, i) => out.set(fromHex(key.toString()), 32 * i));
  return out;
}

/** Sign, assemble, and engine-verify `spec` (fourk-wasm). Throws with the
 * builder's or the script engine's reason. */
export function buildTx(spec: TxSpec, keys: PrivateKey[]): BuiltTx {
  const secrets = secretsOf(keys);
  try {
    return JSON.parse(fourk.buildTransaction(JSON.stringify(spec), secrets)) as BuiltTx;
  } finally {
    secrets.fill(0); // the JS-side copy; the SDK's own key object keeps the secret
  }
}

/** Rebuild the SDK transaction object the RPC submits, from the builder's
 * JSON. CovenantBinding objects are constructed fresh because the SDK's
 * TransactionOutput consumes them. */
function toSdkTransaction(built: BuiltTx) {
  return new kaspa.Transaction({
    version: built.version,
    inputs: built.inputs.map(
      (i) =>
        new kaspa.TransactionInput({
          previousOutpoint: { transactionId: i.transactionId, index: i.index },
          signatureScript: i.signatureScript,
          sequence: BigInt(i.sequence),
          sigOpCount: i.sigOpCount,
          computeBudget: i.computeBudget,
        } as any),
    ),
    outputs: built.outputs.map(
      (o) =>
        new kaspa.TransactionOutput(
          BigInt(o.value),
          new kaspa.ScriptPublicKey(o.scriptVersion, fromHex(o.script)),
          o.covenant
            ? new kaspa.CovenantBinding(
                o.covenant.authorizingInput,
                new kaspa.Hash(o.covenant.covenantId),
              )
            : undefined,
        ),
    ),
    lockTime: BigInt(built.lockTime),
    gas: BigInt(built.gas),
    payload: built.payload,
    subnetworkId: built.subnetworkId,
  } as any);
}

/** The node's current priority feerate (sompi per gram), floored. */
export async function currentFeerate(rpc: Rpc): Promise<bigint> {
  const estimate: any = await withRetry(() => rpc.getFeeEstimate({} as any));
  return bigMax(
    BigInt(Math.ceil(Number(estimate.estimate.priorityBucket.feerate))),
    MIN_RELAY_FEERATE,
  );
}

/**
 * Build `specOf(fee)` and submit it. The fee is sized from the transaction
 * itself: a first build measures the fee mass (compute vs transient, as the
 * mempool prices it), the second carries `feeMass * feerate`. Both builds run
 * every input through the script engine, so what gets submitted has already
 * verified locally.
 */
export async function submitSpec(
  rpc: Rpc,
  keys: PrivateKey[],
  specOf: (fee: bigint) => TxSpec,
): Promise<{ txid: string; built: BuiltTx }> {
  const draft = buildTx(specOf(0n), keys);
  const feerate = await currentFeerate(rpc);
  const fee = BigInt(draft.mass.fee) * feerate;
  const built = buildTx(specOf(fee), keys);
  const final = toSdkTransaction(built);
  try {
    const res = await rpc.submitTransaction({ transaction: final as any, allowOrphan: false });
    return { txid: String(res.transactionId), built };
  } catch (e) {
    // A dropped websocket may have eaten the RESPONSE, not the transaction.
    // Resubmit the identical tx once; "already known" then means success.
    if (!isTransient(e)) throw e;
    await sleep(2500);
    try {
      const res = await rpc.submitTransaction({ transaction: final as any, allowOrphan: false });
      return { txid: String(res.transactionId), built };
    } catch (e2: any) {
      if (/already/i.test(String(e2?.message ?? e2))) return { txid: built.id, built };
      throw e2;
    }
  }
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
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
  const pk = walletPubkey(key);

  let sent = 0n;
  const { txid } = await submitSpec(rpc, [key], (fee) => {
    sent = sweep ? total - fee : (amount as bigint);
    if (sent < DUST) throw new Error("LOW_BALANCE"); // fee ate the sweep
    return {
      network: NETWORK_ID,
      inputs: funding.map((f) => fundingInput(f, 0, pk)),
      outputs: sweep
        ? [scriptOutput(destSpk, sent)]
        : withChange([scriptOutput(destSpk, sent)], changeSpk, total - sent - fee),
    };
  });
  return { txid, amount: sent };
}

// --- The door shapes -----------------------------------------------------------

export interface MatchTiming {
  /** Per-move forfeit clock, DAA blocks (>= contract floor of 600). */
  moveTimeout: number;
  /** Total game duration, DAA blocks; 0 = uncapped. Converted to an
   * absolute sudden-death deadline off the chain's current DAA score. */
  totalCap: number;
}

/** Genesis: fund a fresh covenant output of `stake` at the mode-derived
 * address for `genesis`. The covenant id is derived by the builder from the
 * funding input. Returns the covenant id and txid. */
export async function openCovenant(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  genesis: Match,
): Promise<{ covenantId: string; txid: string }> {
  const stake = genesis.value;
  const funding = await pickFunding(rpc, key, stake + FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const pk = walletPubkey(key);

  const { txid, built } = await submitSpec(rpc, [key], (fee) => ({
    network: NETWORK_ID,
    inputs: funding.map((f) => fundingInput(f, 0, pk)),
    outputs: withChange(
      [
        {
          kind: "genesis",
          actor: mode.actorOf(genesis),
          state: mode.stateOf(genesis),
          authorizingInput: 0,
          value: stake.toString(),
        },
      ],
      changeSpk,
      fundingTotal(funding) - stake - fee,
    ),
  }));
  const covenantId = built.outputs[0]?.covenant?.covenantId;
  if (!covenantId) throw new Error("genesis output carries no covenant id");
  return { covenantId, txid };
}

/** Continuation spend (join / move / commit / reveal / resolve / claim_win):
 * game input + funding, pot preserved (+delta on join). `args` are the
 * entry's arguments in ABI order (`{ sig: 0 }` is the caller's signature);
 * `next` is the successor snapshot; mode-specific Match fields ride along. */
export async function continuation(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  entry: string,
  args: EntryArg[],
  next: { state: State; simul?: SimulCore },
  potDelta: bigint,
  payload = "",
): Promise<Match> {
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, potDelta + FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const pk = walletPubkey(key);
  const nextValue = match.value + potDelta;
  const nextMatch: Match = {
    ...match,
    state: next.state,
    ...(next.simul && { simul: next.simul }),
    value: nextValue,
  };

  const { txid } = await submitSpec(rpc, [key], (fee) => ({
    network: NETWORK_ID,
    payload,
    inputs: [
      gameInput(mode, match, gameUtxo, entry, args),
      ...funding.map((f) => fundingInput(f, 0, pk)),
    ],
    outputs: withChange(
      [successorOutput(mode, nextMatch, 0, nextValue)],
      changeSpk,
      fundingTotal(funding) - potDelta - fee,
    ),
  }));
  return untilIndexed(rpc, mode, { ...nextMatch, txid }, match);
}

/** Signed terminal door (cancel / winning_move / claim_forfeit / claim_timeout
 * / sweep_win): pot minus fee to the caller, who signs and directs freely.
 * `args` in ABI order, the caller's signature as `{ sig: 0 }`. */
export async function signedTerminal(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  entry: string,
  args: EntryArg[],
  sequence = 0n,
): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const payoutSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));

  const { txid } = await submitSpec(rpc, [key], (fee) => ({
    network: NETWORK_ID,
    inputs: [gameInput(mode, match, gameUtxo, entry, args, sequence)],
    outputs: [scriptOutput(payoutSpk, match.value - fee)],
  }));
  return txid;
}

/** Permissionless winner-take-all door: sudden_death fired on a PENDING win.
 * Unlike the even split, the covenant pays the whole pot (minus a self-funded
 * fee) to the pending winner in a single pinned output — so a vanished winner's
 * pot is pushed to them by anyone at the deadline instead of being halved by a
 * stalling loser. No signature: the payout address is fixed by the state, and
 * the covenant enforces both the single output and its destination. */
export async function pinnedWinner(
  rpc: Rpc,
  mode: ModeEngine,
  match: Match,
  entry: string,
  winnerPkHex: string,
  opts: { lockTime?: bigint } = {},
): Promise<string> {
  const { lockTime = 0n } = opts;
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");

  const { txid } = await submitSpec(rpc, [], (fee) => ({
    network: NETWORK_ID,
    lockTime: lockTime.toString(),
    inputs: [gameInput(mode, match, gameUtxo, entry, [])],
    outputs: [p2pkOutput(winnerPkHex, match.value - fee)],
  }));
  return txid;
}

/** Pinned-split door (claim_draw / sudden_death / claim_split / split_timeout
 * / dissolve): self-funded, single input — only the match UTXO is spent (the
 * covenant rejects any second input: the anti-aggregation guard), the fee is
 * shaved from the pot and the rest splits equally into outputs 0/1 pinned to
 * the players. `signer` makes it a signed door (dissolve); `awaitRefund`
 * waits until the caller's refund is indexed (a kick chains straight into
 * hosting a fresh game off the same UTXO set). */
export async function pinnedSplit(
  rpc: Rpc,
  key: PrivateKey,
  mode: ModeEngine,
  match: Match,
  entry: string,
  args: EntryArg[],
  opts: { sequence?: bigint; lockTime?: bigint; signed?: boolean; awaitRefund?: boolean } = {},
): Promise<string> {
  const { sequence = 0n, lockTime = 0n, signed = false, awaitRefund = false } = opts;
  const gameUtxo = await fetchGameUtxo(rpc, mode, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");

  const { txid } = await submitSpec(rpc, signed ? [key] : [], (fee) => {
    const each = (match.value - fee) / 2n;
    return {
      network: NETWORK_ID,
      lockTime: lockTime.toString(),
      inputs: [gameInput(mode, match, gameUtxo, entry, args, sequence)],
      outputs: [p2pkOutput(match.state.p1, each), p2pkOutput(match.state.p2, each)],
    };
  });

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
  /** Data pushes of the entry call (sig, pk — dispatch tag and redeem excluded). */
  pushes: Uint8Array[];
  /** Small-integer arguments of the entry call, in declared order (e.g. the
   * played column leads winning_move's [col, wcol, wrow, wdir]). Data pushes
   * like the signature don't appear here. */
  args: number[];
  /** The spending transaction's payload, hex (profile channel on joins). */
  payload: string;
}

const tagTables = new Map<string, Record<string, string>>();

/** An actor's entry dispatch tags (hex) -> entry names, from the artifact. */
export function entryTags(actor: string): Record<string, string> {
  let table = tagTables.get(actor);
  if (!table) {
    table = JSON.parse(fourk.entryTags(actor)) as Record<string, string>;
    tagTables.set(actor, table);
  }
  return table;
}

/**
 * Find the transaction that spent the current game UTXO in blocks since
 * `lowHash` and classify which covenant entrypoint it called: an entry call's
 * signature script ends with the 4-byte dispatch tag push, then the pushed
 * redeem script, and `tags` is the actor's tag table. Pages through
 * getBlocks up to the tip — a backgrounded tab can wake hours past its
 * checkpoint. Returns null if the spend is outside the scanned window;
 * throws if `lowHash` is unknown to the node (e.g. pruned).
 */
export async function discoverSpend(
  rpc: Rpc,
  match: Match,
  lowHash: string,
  tags: Record<string, string>,
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
          const tag = tokens.length >= 2 ? tokens[tokens.length - 2]!.data : null;
          const kind = tag && tag.length === 4 ? tags[toHex(tag)] : undefined;
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
  const info: any = await withRetry(() => rpc.getBlockDagInfo());
  return Number(BigInt(info.virtualDaaScore) - entryDaaScore(entry));
}

export function myRole(match: Match, pkHex: string): "p1" | "p2" | "spectator" {
  if (match.state.p1 === pkHex) return "p1";
  if (match.state.p2 === pkHex) return "p2";
  return "spectator";
}
