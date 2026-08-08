/**
 * The app-facing covenant API: opening/joining matches, the mode-generic
 * doors, chain sync, and spend discovery. Everything mode-specific is asked
 * of the match's GameMode (shared/modes/); everything transaction-mechanical
 * lives in engine.ts. Per-mode player actions (moves, commits, claims) live
 * on the mode modules — shared/modes/(classic|fourk)/actions.ts.
 */

import { ZERO_PK, type State } from "./game";
import { NETWORK_ID, fromHex, type Match, type PlayerProfile } from "./match";
import * as engine from "./engine";
import { MODES, modeOf } from "../modes/registry";
import type { GameModeKey } from "../modes/types";
import { drawMatch as modeDraw, suddenDeathMatch as modeSuddenDeath } from "../modes/common";

// Mode-agnostic engine surface, re-exported so consumers keep one import.
export {
  FEE_HEADROOM,
  chainCheckpoint,
  connect,
  myRole,
  sendTo,
  walletAddress,
  walletBalance,
  walletPubkey,
} from "./engine";
export type { MatchTiming, PrivateKey, Rpc, SpendInfo, UtxoEntryLike } from "./engine";
import type { PrivateKey, Rpc } from "./engine";

/** The game address of a match snapshot, mode-aware. */
export function matchAddress(m: Match): string {
  return engine.matchAddress(modeOf(m), m);
}

/** DAA-block age of the current game UTXO, for the forfeit countdown. */
export async function gameUtxoAge(rpc: Rpc, match: Match): Promise<number | null> {
  return engine.gameUtxoAge(rpc, modeOf(match), match);
}

/** Does pkHex owe this match an action right now? (Classic: my turn; fourk:
 * I owe the round a commit/reveal/resolve.) */
export function isActionable(match: Match, pkHex: string): boolean {
  return modeOf(match).isActionable(match, pkHex);
}

// --- Opening / joining -------------------------------------------------------

export async function openMatch(
  rpc: Rpc,
  key: PrivateKey,
  stake: bigint,
  timing: engine.MatchTiming,
  modeKey: GameModeKey = "classic",
): Promise<Match> {
  const mode = MODES[modeKey];
  // A deadline is mandatory — the covenant refuses to seat a joiner without
  // one (it is the permissionless exit that keeps an abandoned pot
  // spendable), so opening capless would just mint an unjoinable lobby.
  if (timing.totalCap <= 0) throw new Error("openMatch requires a total game cap");
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  const deadline = Number(info.virtualDaaScore) + timing.totalCap;
  const genesis: State = {
    p1: engine.walletPubkey(key),
    p2: ZERO_PK,
    board: new Uint8Array(42),
    moveCount: 0,
    stake,
    moveTimeout: timing.moveTimeout,
    deadline,
  };
  const draft: Match = {
    network: NETWORK_ID,
    covenantId: "",
    state: genesis,
    txid: "",
    value: stake,
    ...mode.genesisFields(),
  };
  const { covenantId, txid } = await engine.openCovenant(rpc, key, mode, draft);
  return engine.untilIndexed(rpc, mode, { ...draft, covenantId, txid });
}

/** The least game time a joiner should accept: below two move clocks (or
 * half an hour, whichever is more), sudden death would split the pot
 * mid-game — and a deadline already in the past is the trap this check
 * exists for: the covenant CANNOT reject it (script can prove time passed,
 * never time remaining), so a host could otherwise craft an
 * expired-deadline invite and permissionlessly refund both stakes whenever
 * they're losing. The app's seat-taking flow enforces this BEFORE funding
 * the seat; joinMatch itself stays policy-free so tests and tools can
 * exercise short-capped games deliberately. */
export async function assertJoinableDeadline(rpc: Rpc, match: Match): Promise<void> {
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  const remaining = match.state.deadline - Number(info.virtualDaaScore);
  const floor = Math.max(2 * match.state.moveTimeout, 18_000);
  if (match.state.deadline <= 0 || remaining < floor) throw new Error("DEADLINE_TOO_CLOSE");
}

export async function joinMatch(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  profile?: PlayerProfile,
): Promise<Match> {
  const mode = modeOf(match);
  const pkHex = engine.walletPubkey(key);
  const nextState: State = { ...match.state, board: match.state.board.slice(), p2: pkHex };
  const joined = await engine.continuation(
    rpc,
    key,
    mode,
    match,
    "join",
    () => ({ pk: fromHex(pkHex), ints: [] }),
    { state: nextState, ...mode.joinFields(match) },
    match.value,
    engine.profilePayloadHex(profile),
  );
  return profile?.name ? { ...joined, profiles: { ...joined.profiles, p2: profile } } : joined;
}

// --- Mode-generic doors ------------------------------------------------------
//
// These exist at the same selector positions in every mode's actors, so one
// facade covers all rule sets.

export async function cancelMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return engine.signedTerminal(rpc, key, modeOf(match), match, "cancel", []);
}

/**
 * Unwind a joined match before anything has been staked on the board: P1
 * kicking the joiner or P2 leaving an unstarted lobby. The covenant pins
 * outputs 0/1 to each player's own stake, so fees ride on a funding input.
 */
export async function dissolveMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  const pkHex = engine.walletPubkey(key);
  // The joiner's exit proves this.age >= move_timeout (the anti-grief gate);
  // the sequence field is what carries that proof. P1's kick is instant.
  const sequence = pkHex === match.state.p2 ? BigInt(match.state.moveTimeout) : 0n;
  return engine.pinnedSplit(rpc, key, modeOf(match), match, "dissolve", [], {
    sequence,
    signerPk: fromHex(pkHex),
    awaitRefund: true,
  });
}

export async function drawMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return modeDraw(rpc, key, modeOf(match), match);
}

export async function suddenDeathMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return modeSuddenDeath(rpc, key, modeOf(match), match);
}

// --- Sync / discovery --------------------------------------------------------

export type SyncStatus = "current" | "advanced" | "terminated";

/** Follow the chain from the match's known UTXO through every enumerable
 * successor. "terminated" means only "no enumerable successor holds the
 * covenant" — a blind-phase continuation looks the same as a terminal spend
 * here; discoverAdvance disambiguates. */
export async function syncMatch(
  rpc: Rpc,
  match: Match,
): Promise<{ status: SyncStatus; match: Match }> {
  const mode = modeOf(match);
  let advanced = false;
  for (;;) {
    if (await engine.fetchGameUtxo(rpc, mode, match))
      return { status: advanced ? "advanced" : "current", match };
    const successor = await findSuccessor(rpc, match);
    if (!successor) return { status: "terminated", match };
    match = successor;
    advanced = true;
  }
}

async function findSuccessor(rpc: Rpc, match: Match): Promise<Match | null> {
  const candidates = modeOf(match).successors(match);
  if (!candidates.length) return null;
  // One batched query for all candidate successor addresses: over a remote
  // public node, sequential per-address queries would stack a full RTT each.
  const byAddress = new Map(candidates.map((next) => [matchAddress(next), next]));
  const res: any = await engine.withRetry(() => rpc.getUtxosByAddresses([...byAddress.keys()]));
  for (const entry of res.entries ?? []) {
    if (String(entry.entry?.covenantId ?? entry.covenantId ?? "") !== match.covenantId) continue;
    const next = byAddress.get(String(entry.address ?? entry.entry?.address ?? ""));
    if (next) return { ...next, txid: engine.entryTxId(entry), value: engine.entryAmount(entry) };
  }
  return null;
}

/** Trace and classify the spend of the current game UTXO (see engine). */
export async function discoverSpend(
  rpc: Rpc,
  match: Match,
  lowHash: string,
): Promise<engine.SpendInfo | null> {
  return engine.discoverSpend(rpc, match, lowHash, modeOf(match).selectorTable(match));
}

/**
 * Adopt the successor a traced continuation spend produced. The mode
 * re-derives the successor from the spend's pushes; it is adopted only if
 * the derived address actually holds the covenant UTXO — trustless. A
 * joiner's profile rides the join tx's payload and is lifted with it.
 * Null for terminal spends and re-derivations that don't verify.
 */
export async function adoptSpend(
  rpc: Rpc,
  match: Match,
  spend: engine.SpendInfo,
): Promise<Match | null> {
  const derived = modeOf(match).rederiveSpend(match, spend);
  if (!derived) return null;
  const entries = await engine.utxosAt(rpc, matchAddress(derived));
  const hit = entries.find((e) => !spend.txid || engine.entryTxId(e) === spend.txid);
  if (!hit) return null;
  const p2Profile = spend.kind === "join" ? engine.profileFromPayload(spend.payload) : null;
  return {
    ...derived,
    txid: engine.entryTxId(hit),
    value: engine.entryAmount(hit),
    ...(p2Profile && { profiles: { ...match.profiles, p2: p2Profile } }),
  };
}

/**
 * The blind-phase catch-up: trace the spend of the current game UTXO and
 * adopt whatever continuation it produced (a join's unknown pubkey, a
 * fourk commit's unknown hash, or any round spend a sleeping watcher
 * missed). Null for terminal spends and untraceable ones.
 */
export async function discoverAdvance(
  rpc: Rpc,
  match: Match,
  lowHash: string,
): Promise<Match | null> {
  const spend = await discoverSpend(rpc, match, lowHash);
  if (!spend) return null;
  return adoptSpend(rpc, match, spend);
}

/** Re-exported for the watcher's ending classification. */
export { modeOf } from "../modes/registry";
