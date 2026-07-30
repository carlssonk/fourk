/**
 * Browser transaction engine for the Fourk covenant, on the kaspa wasm SDK
 * plus fourk-wasm (state -> scripts).
 *
 * Transaction shapes and conventions:
 *   - v1 transactions; covenant input budget 12, P2PK funding budget 10
 *   - continuation spends preserve the pot exactly (fees on a funding input)
 *   - signed terminal doors pay fees out of the pot
 *   - claim_draw pins outputs 0/1 to the players at half the pot each
 *   - fee floor: max(SDK mass, serialized_size * 2) * max(feerate, 100)
 *   - sighash ignores signature scripts: sign a placeholder-shaped tx, then
 *     splice the real signatures in
 */

import { fourk, kaspa } from "./sdk";
import {
  MOVE_TIMEOUT_DAA,
  ZERO_PK,
  applyMove,
  legalColumns,
  playerToMove,
  type LineWitness,
  type State,
} from "./game";
import { NETWORK_ID, fromHex, phaseOf, toHex, type Match, type PlayerProfile } from "./match";
import { decodeProfileBytes, encodeProfileBytes } from "./sharecode";

const NETWORK_TYPE = "testnet";
const SUBNETWORK_ID = "00".repeat(20);
const COVENANT_BUDGET = 12;
const P2PK_BUDGET = 10;
const DUST = 20_000n;
const MIN_RELAY_FEERATE = 100n;
export const FEE_HEADROOM = 2_000_000n;
const PLACEHOLDER_SIG = new Uint8Array(65);

export type Rpc = InstanceType<typeof kaspa.RpcClient>;
export type PrivateKey = InstanceType<typeof kaspa.PrivateKey>;
type Transaction = InstanceType<typeof kaspa.Transaction>;

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

function isTransient(e: unknown): boolean {
  return TRANSIENT.test(String((e as any)?.message ?? e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isTransient(e)) throw e;
      await sleep(1000 * (i + 1)); // give auto-reconnect time to re-establish
    }
  }
}

// --- State -> scripts / addresses -------------------------------------------
//
// The Argent artifact splits the old single contract into two actors: an
// OPEN state (p2 == zero key) is a FourkLobby covenant, a LIVE state is a
// FourkMatch covenant. phaseOf picks the actor; the State model is unchanged.

function isOpen(s: State): boolean {
  return phaseOf(s) === 0;
}

function matchArgs(s: State): [Uint8Array, Uint8Array, Uint8Array, bigint, bigint, bigint] {
  return [
    fromHex(s.p1),
    fromHex(s.p2),
    s.board,
    BigInt(s.moveCount),
    BigInt(s.moveTimeout),
    BigInt(s.deadline),
  ];
}

export function lockRedeem(s: State): Uint8Array {
  return isOpen(s)
    ? fourk.lobbyLockScript(fromHex(s.p1), BigInt(s.moveTimeout), BigInt(s.deadline))
    : fourk.matchLockScript(...matchArgs(s));
}

function gameSpk(s: State) {
  return kaspa.payToScriptHashScript(lockRedeem(s));
}

export function gameAddress(s: State): string {
  const addr = kaspa.addressFromScriptPublicKey(gameSpk(s), NETWORK_TYPE);
  if (!addr) throw new Error("cannot derive game address");
  return addr.toString();
}

/** Full input signature script for an entrypoint call (incl. pushed redeem
 * and any compiler-generated witness args, e.g. join's template witness). */
function entrySigScript(
  s: State,
  fn: string,
  sig: Uint8Array | undefined,
  pk: Uint8Array | undefined,
  ints: number[],
): string {
  const intArgs = ints.length ? BigInt64Array.from(ints.map(BigInt)) : undefined;
  return toHex(
    isOpen(s)
      ? fourk.lobbySigScript(fromHex(s.p1), BigInt(s.moveTimeout), BigInt(s.deadline), fn, sig, pk)
      : fourk.matchSigScript(...matchArgs(s), fn, sig, pk, intArgs),
  );
}

export function walletAddress(key: PrivateKey): string {
  return key.toAddress(NETWORK_TYPE).toString();
}

export function walletPubkey(key: PrivateKey): string {
  return kaspa.Keypair.fromPrivateKey(key).xOnlyPublicKey;
}

// --- UTXO access -------------------------------------------------------------

async function utxosAt(rpc: Rpc, address: string): Promise<UtxoEntryLike[]> {
  const res = await withRetry(() => rpc.getUtxosByAddresses([address]));
  return (res.entries ?? []) as unknown as UtxoEntryLike[];
}

function entryAmount(entry: UtxoEntryLike): bigint {
  return BigInt((entry.amount ?? entry.utxoEntry?.amount)!);
}

function entryTxId(entry: UtxoEntryLike): string {
  const outpoint = entry.outpoint ?? entry.entry?.outpoint;
  return String(outpoint!.transactionId);
}

export async function walletBalance(rpc: Rpc, address: string): Promise<bigint> {
  const entries = await utxosAt(rpc, address);
  return entries.reduce((sum, e) => sum + entryAmount(e), 0n);
}

async function fetchGameUtxo(rpc: Rpc, match: Match): Promise<UtxoEntryLike | null> {
  const entries = await utxosAt(rpc, gameAddress(match.state));
  return entries.find((e) => entryTxId(e) === match.txid) ?? null;
}

/** Wait until the node's UTXO index reflects a freshly submitted game UTXO.
 * Callers hand the returned Match straight to watchers whose first tick reads
 * "UTXO absent" as "UTXO spent" — if that tick beats block acceptance, a
 * brand-new game looks terminated. Best-effort: on timeout the match is
 * returned anyway and the watchers' fallback poll takes over. */
async function untilIndexed(rpc: Rpc, match: Match): Promise<Match> {
  for (let i = 0; i < 40; i++) {
    if (await fetchGameUtxo(rpc, match)) break;
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

function gameInput(match: Match, gameUtxo: UtxoEntryLike, sigScriptHex: string, sequence = 0n) {
  return new kaspa.TransactionInput({
    previousOutpoint: { transactionId: match.txid, index: 0 },
    signatureScript: sigScriptHex,
    sequence,
    sigOpCount: 0,
    computeBudget: COVENANT_BUDGET,
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

function profilePayloadHex(profile: PlayerProfile | undefined): string {
  if (!profile?.name) return "";
  return PROFILE_PAYLOAD_MAGIC + toHex(encodeProfileBytes(profile));
}

function profileFromPayload(payloadHex: string): PlayerProfile | null {
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

// --- Match actions -----------------------------------------------------------

export interface MatchTiming {
  /** Per-move forfeit clock, DAA blocks (>= contract floor of 600). */
  moveTimeout: number;
  /** Total game duration, DAA blocks; 0 = uncapped. Converted to an
   * absolute sudden-death deadline off the chain's current DAA score. */
  totalCap: number;
}

export async function openMatch(
  rpc: Rpc,
  key: PrivateKey,
  stake: bigint,
  timing: MatchTiming = { moveTimeout: MOVE_TIMEOUT_DAA, totalCap: 0 },
): Promise<Match> {
  let deadline = 0;
  if (timing.totalCap > 0) {
    const info: any = await withRetry(() => rpc.getBlockDagInfo());
    deadline = Number(info.virtualDaaScore) + timing.totalCap;
  }
  const genesis: State = {
    p1: walletPubkey(key),
    p2: ZERO_PK,
    board: new Uint8Array(42),
    moveCount: 0,
    stake,
    moveTimeout: timing.moveTimeout,
    deadline,
  };
  const spk = gameSpk(genesis);
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
  return untilIndexed(rpc, { network: NETWORK_ID, covenantId, state: genesis, txid, value: stake });
}

/** Continuation spend (join / move): game input + funding, pot preserved (+delta on join). */
async function transition(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  fn: string,
  callArgs: (sig: Uint8Array) => { pk?: Uint8Array; ints: number[] },
  nextState: State,
  potDelta: bigint,
  payload = "",
): Promise<Match> {
  const gameUtxo = await fetchGameUtxo(rpc, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, potDelta + FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const nextValue = match.value + potDelta;

  const build: Build = (fee, sigs) => {
    const { pk, ints } = callArgs(sigs.get(0)!);
    const inputs = [
      gameInput(match, gameUtxo, entrySigScript(match.state, fn, sigs.get(0)!, pk, ints)),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    // The TransactionOutput constructor CONSUMES the CovenantBinding wasm
    // object (passed by value into Rust) — it must be constructed fresh on
    // every build, or the signed/submitted rebuilds silently lose the
    // binding and the covenant's OpAuthOutputCount check fails on-chain.
    const binding = new kaspa.CovenantBinding(0, new kaspa.Hash(match.covenantId));
    const outputs = withChange(
      [new kaspa.TransactionOutput(nextValue, gameSpk(nextState), binding)],
      changeSpk,
      fundingTotal(funding) - potDelta - fee,
    );
    return makeTx(inputs, outputs, payload);
  };

  const txid = await send(rpc, build, [
    [0, key],
    ...funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  ]);
  return untilIndexed(rpc, { ...match, state: nextState, txid, value: nextValue });
}

export async function joinMatch(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  profile?: PlayerProfile,
): Promise<Match> {
  const pkHex = walletPubkey(key);
  const nextState: State = { ...match.state, board: match.state.board.slice(), p2: pkHex };
  const joined = await transition(
    rpc,
    key,
    match,
    "join",
    () => ({ pk: fromHex(pkHex), ints: [] }),
    nextState,
    match.value,
    profilePayloadHex(profile),
  );
  return profile?.name ? { ...joined, profiles: { ...joined.profiles, p2: profile } } : joined;
}

export async function moveMatch(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  col: number,
): Promise<Match> {
  return transition(
    rpc,
    key,
    match,
    "move",
    () => ({ ints: [col] }),
    applyMove(match.state, col),
    0n,
  );
}

/** Signed terminal door (cancel / winning_move / claim_forfeit): pot minus fee to caller. */
async function terminal(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  fn: string,
  ints: number[],
  sequence = 0n,
): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const payoutSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        entrySigScript(match.state, fn, sigs.get(0)!, undefined, ints),
        sequence,
      ),
    ];
    return makeTx(inputs, [new kaspa.TransactionOutput(match.value - fee, payoutSpk)]);
  };

  return send(rpc, build, [[0, key]]);
}

export async function winMatch(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  col: number,
  w: LineWitness,
): Promise<string> {
  return terminal(rpc, key, match, "winning_move", [col, w.col, w.row, w.dir]);
}

export async function cancelMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return terminal(rpc, key, match, "cancel", []);
}

export async function forfeitMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return terminal(rpc, key, match, "claim_forfeit", [], BigInt(match.state.moveTimeout));
}

/**
 * Unwind a joined match before the first disc: P1 kicking the joiner or P2
 * leaving an unstarted lobby. The covenant pins outputs 0/1 to each player's
 * own stake (claim_draw's shape), so fees ride on a funding input.
 */
export async function dissolveMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const half = match.value / 2n;
  const pkHex = walletPubkey(key);
  const pk = fromHex(pkHex);
  // The joiner's exit proves this.age >= move_timeout (the anti-grief gate);
  // the sequence field is what carries that proof. P1's kick is instant.
  const sequence = pkHex === match.state.p2 ? BigInt(match.state.moveTimeout) : 0n;

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        entrySigScript(match.state, "dissolve", sigs.get(0)!, pk, []),
        sequence,
      ),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    const outputs = withChange(
      [p2pkOutput(match.state.p1, half), p2pkOutput(match.state.p2, half)],
      changeSpk,
      fundingTotal(funding) - fee,
    );
    return makeTx(inputs, outputs);
  };

  const txid = await send(rpc, build, [
    [0, key],
    ...funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  ]);
  // A kick chains straight into hosting a fresh game, which picks funding
  // from the node's UTXO index — wait until the index reflects this spend
  // (our refund appearing means the consumed inputs are gone; both update
  // atomically), or the follow-up rebuilds on stale UTXOs and bounces off
  // the node as an orphan. Best-effort, like untilIndexed.
  const mine = walletAddress(key);
  for (let i = 0; i < 20; i++) {
    const entries = await utxosAt(rpc, mine);
    if (entries.some((e) => entryTxId(e) === txid)) break;
    await sleep(500);
  }
  return txid;
}

export async function drawMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const half = match.value / 2n;

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        entrySigScript(match.state, "claim_draw", undefined, undefined, []),
      ),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    const outputs = withChange(
      [p2pkOutput(match.state.p1, half), p2pkOutput(match.state.p2, half)],
      changeSpk,
      fundingTotal(funding) - fee,
    );
    return makeTx(inputs, outputs);
  };

  return send(
    rpc,
    build,
    funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  );
}

/**
 * Split a capped game that outlived its deadline: pinned half-pot refunds to
 * each player (claim_draw's shape), fees on a funding input, and the tx's
 * lockTime proving the chain has passed the deadline — the node simply won't
 * mine it early.
 */
export async function suddenDeathMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  const gameUtxo = await fetchGameUtxo(rpc, match);
  if (!gameUtxo) throw new Error("game UTXO not found on chain — sync first");
  const funding = await pickFunding(rpc, key, FEE_HEADROOM);
  const changeSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress(key)));
  const half = match.value / 2n;

  const build: Build = (fee, sigs) => {
    const inputs = [
      gameInput(
        match,
        gameUtxo,
        entrySigScript(match.state, "sudden_death", undefined, undefined, []),
      ),
      ...funding.map((f, i) => fundingInput(f, fullP2pkSigScript(sigs.get(i + 1)!))),
    ];
    const outputs = withChange(
      [p2pkOutput(match.state.p1, half), p2pkOutput(match.state.p2, half)],
      changeSpk,
      fundingTotal(funding) - fee,
    );
    return makeTx(inputs, outputs, "", BigInt(match.state.deadline));
  };

  return send(
    rpc,
    build,
    funding.map((_, i): [number, PrivateKey] => [i + 1, key]),
  );
}

// --- Sync / watching ---------------------------------------------------------

export type SyncStatus = "current" | "advanced" | "terminated";

export async function syncMatch(
  rpc: Rpc,
  match: Match,
): Promise<{ status: SyncStatus; match: Match }> {
  let advanced = false;
  for (;;) {
    if (await fetchGameUtxo(rpc, match))
      return { status: advanced ? "advanced" : "current", match };
    const successor = await findSuccessor(rpc, match);
    if (!successor) return { status: "terminated", match };
    match = successor;
    advanced = true;
  }
}

async function findSuccessor(rpc: Rpc, match: Match): Promise<Match | null> {
  // A join successor embeds the unknown joiner pubkey — discovered via
  // discoverJoin instead.
  if (phaseOf(match.state) === 0) return null;
  const candidates = legalColumns(match.state).map((c) => applyMove(match.state, c));
  if (!candidates.length) return null;
  // One batched query for all candidate successor addresses: over a remote
  // public node, sequential per-address queries would stack a full RTT each.
  const byAddress = new Map(candidates.map((s) => [gameAddress(s), s]));
  const res: any = await withRetry(() => rpc.getUtxosByAddresses([...byAddress.keys()]));
  for (const entry of res.entries ?? []) {
    if (String(entry.entry?.covenantId ?? entry.covenantId ?? "") !== match.covenantId) continue;
    const state = byAddress.get(String(entry.address ?? entry.entry?.address ?? ""));
    if (state) return { ...match, state, txid: entryTxId(entry), value: entryAmount(entry) };
  }
  return null;
}

/** A recent chain block hash, captured while waiting so a later spend of the
 * game UTXO can be traced through getBlocks. */
export async function chainCheckpoint(rpc: Rpc): Promise<string> {
  const info: any = await withRetry(() => rpc.getBlockDagInfo());
  return String(info.sink);
}

/** Entrypoints in ABI/selector order — must match fourk.ag declaration order
 * per actor (each generated contract numbers its own selectors from 0). */
const LOBBY_ENTRYPOINTS = ["join", "cancel"] as const;
const MATCH_ENTRYPOINTS = [
  "dissolve",
  "move",
  "winning_move",
  "claim_draw",
  "claim_forfeit",
  "sudden_death",
] as const;
export type SpendKind = (typeof LOBBY_ENTRYPOINTS)[number] | (typeof MATCH_ENTRYPOINTS)[number];

export interface SpendInfo {
  kind: SpendKind;
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
 * selector sits directly before the pushed redeem script). Pages through
 * getBlocks up to the tip — a backgrounded tab can wake hours past its
 * checkpoint. Returns null if the spend is outside the scanned window;
 * throws if `lowHash` is unknown to the node (e.g. pruned).
 */
export async function discoverSpend(
  rpc: Rpc,
  match: Match,
  lowHash: string,
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
          const table = isOpen(match.state) ? LOBBY_ENTRYPOINTS : MATCH_ENTRYPOINTS;
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

/**
 * After a join spends the genesis UTXO: extract the joiner's pubkey from the
 * join call's signature script and reconstruct the successor state.
 * Trustless — only adopted if the derived successor address actually holds
 * the covenant UTXO. Returns null for a cancel or an untraceable spend.
 */
export async function discoverJoin(rpc: Rpc, match: Match, lowHash: string): Promise<Match | null> {
  const spend = await discoverSpend(rpc, match, lowHash);
  if (!spend || spend.kind !== "join") return null;
  const pk = spend.pushes.find((p) => p.length === 32);
  if (!pk) return null;
  const state: State = { ...match.state, board: match.state.board.slice(), p2: toHex(pk) };
  const entries = await utxosAt(rpc, gameAddress(state));
  const hit = entries.find((e) => !spend.txid || entryTxId(e) === spend.txid);
  if (!hit) return null;
  // The joiner's profile rides the join tx's payload — lift it out with them.
  const p2Profile = profileFromPayload(spend.payload);
  return {
    ...match,
    state,
    txid: entryTxId(hit),
    value: entryAmount(hit),
    ...(p2Profile && { profiles: { ...match.profiles, p2: p2Profile } }),
  };
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
export async function gameUtxoAge(rpc: Rpc, match: Match): Promise<number | null> {
  const entry = await fetchGameUtxo(rpc, match);
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

export function isMyTurn(match: Match, pkHex: string): boolean {
  const mover = playerToMove(match.state) === 0 ? match.state.p1 : match.state.p2;
  return mover === pkHex;
}
