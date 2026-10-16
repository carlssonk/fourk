/**
 * The app-facing covenant API: opening/joining matches, the mode-generic
 * doors, chain sync, and spend discovery. Everything mode-specific is asked
 * of the match's GameMode (shared/modes/); everything transaction-mechanical
 * lives in engine.ts. Per-mode player actions (moves, commits, claims) live
 * on the mode modules — shared/modes/(classic|fourk)/actions.ts.
 */

import { ZERO_PK, type State } from "./game";
import { NETWORK_ID, loadCheckpoint, type Match, type PlayerProfile } from "./match";
import * as engine from "./engine";
import { MODES, modeOf } from "../modes/registry";
import type { ClockSpec, GameModeKey, GenesisOptions } from "../modes/types";
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

/**
 * Minutes still on the move clock, asked of the chain: 0 means the clock has
 * elapsed and a timeout door is open; null means the game UTXO wasn't found.
 * The on-screen countdown can lag an age-fetch — callers gate timeout/dissolve
 * doors on this so a slightly-early click gets minutes, not a sequence-lock
 * rejection. `spec` overrides the mode's own clock (the lobby exit).
 */
export async function moveClockRemaining(
  rpc: Rpc,
  match: Match,
  spec: ClockSpec | null = modeOf(match).clock(match),
): Promise<number | null> {
  if (!spec) return 0;
  if (spec.kind === "age") {
    const age = await gameUtxoAge(rpc, match);
    if (age === null) return null;
    return Math.max(0, Math.ceil((spec.daa - age) / 600));
  }
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  return Math.max(0, Math.ceil((spec.daa - Number(info.virtualDaaScore)) / 600));
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
  onSubmit?: (m: Match) => void,
  genesisOptions: GenesisOptions = {},
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
    ...mode.genesisFields(timing, genesisOptions),
  };
  const { covenantId, txid } = await engine.openCovenant(rpc, key, mode, draft, {
    beforeSubmit: (id, tx) => onSubmit?.({ ...draft, covenantId: id, txid: tx }),
  });
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
 * exercise short-capped games deliberately. A caller that knows what cap
 * the game should have (Quick Match) passes `bounds`: `min` raises the
 * floor, and `max` refuses a limit set far beyond it, which would push an
 * abandoned game's last-resort exit out of reach. */
export async function assertJoinableDeadline(
  rpc: Rpc,
  match: Match,
  { min = 0, max }: DeadlineBounds = {},
): Promise<void> {
  const remaining = await gameTimeLeft(rpc, match);
  const floor = Math.max(2 * match.state.moveTimeout, 18_000, min);
  if (match.state.deadline <= 0 || remaining < floor) throw new Error("DEADLINE_TOO_CLOSE");
  if (max !== undefined && remaining > max) throw new Error("DEADLINE_TOO_FAR");
}

/** How much of its whole-game time limit a match has left, DAA blocks,
 * against the chain's current score (negative once it has passed). */
export async function gameTimeLeft(rpc: Rpc, match: Match): Promise<number> {
  const info: any = await engine.withRetry(() => rpc.getBlockDagInfo());
  return match.state.deadline - Number(info.virtualDaaScore);
}

/** How much of its time limit a game may have left, DAA blocks. */
export interface DeadlineBounds {
  min?: number;
  max?: number;
}

export async function joinMatch(
  rpc: Rpc,
  key: PrivateKey,
  match: Match,
  profile?: PlayerProfile,
  onSubmit?: (m: Match) => void,
): Promise<Match> {
  const mode = modeOf(match);
  const pkHex = engine.walletPubkey(key);
  const withProfile = (m: Match): Match =>
    profile?.name ? { ...m, profiles: { ...m.profiles, p2: profile } } : m;
  const nextState: State = { ...match.state, board: match.state.board.slice(), p2: pkHex };
  const joined = await engine.continuation(
    rpc,
    key,
    mode,
    match,
    "join",
    [{ sig: 0 }, { bytes: pkHex }],
    { state: nextState, ...mode.joinFields(match) },
    match.value,
    engine.profilePayloadHex(profile),
    { beforeSubmit: (m) => onSubmit?.(withProfile(m)) },
  );
  return withProfile(joined);
}

// --- Mode-generic doors ------------------------------------------------------
//
// These exist under the same entry names in every mode's actors, so one
// facade covers all rule sets.

export async function cancelMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  return engine.signedTerminal(rpc, key, modeOf(match), match, "cancel", [{ sig: 0 }]);
}

/**
 * Unwind a joined match before anything has been staked on the board: P1
 * kicking the joiner or P2 leaving an unstarted lobby. The covenant pins
 * outputs 0/1 to each player's own stake, so fees ride on a funding input.
 */
export async function dissolveMatch(rpc: Rpc, key: PrivateKey, match: Match): Promise<string> {
  const pkHex = engine.walletPubkey(key);
  // The joiner's exit may have to prove this.ageDaa >= move_timeout (the
  // anti-grief gate); the sequence field is what carries that proof. P1's
  // kick is instant.
  const wait = pkHex === match.state.p2 ? modeOf(match).joinerExitWait(match) : 0;
  const sequence = BigInt(wait);
  return engine.pinnedSplit(
    rpc,
    key,
    modeOf(match),
    match,
    "dissolve",
    [{ sig: 0 }, { bytes: pkHex }],
    {
      sequence,
      signed: true,
      awaitRefund: true,
    },
  );
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
    const entry = await engine.fetchGameUtxo(rpc, mode, match);
    if (entry)
      return { status: advanced ? "advanced" : "current", match: engine.withEntry(match, entry) };
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
    if (next) return engine.withEntry(next, entry);
  }
  return null;
}

/** Trace and classify the spend of the current game UTXO (see engine). */
export async function discoverSpend(
  rpc: Rpc,
  match: Match,
  lowHash: string,
): Promise<engine.SpendInfo | null> {
  const mode = modeOf(match);
  return engine.discoverSpend(rpc, match, lowHash, engine.entryTags(mode.actorOf(match)));
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
  lowHash: string | null = null,
): Promise<Match | null> {
  const mode = modeOf(match);
  // A fourk2 commit successor embeds the cutoff derived from the spent
  // UTXO's acceptance score. The snapshot usually carries it (stamped when
  // the UTXO was seen alive); a client that never saw it alive reads it off
  // the virtual chain from the checkpoint that predates it.
  if (match.acceptedDaa === undefined && mode.needsAcceptedDaa?.(match, spend)) {
    const low = lowHash ?? loadCheckpoint(match.covenantId);
    const daa = low ? await engine.acceptedDaaOf(rpc, match.txid, low).catch(() => null) : null;
    if (daa === null) return null;
    match = { ...match, acceptedDaa: daa };
  }
  const derived = mode.rederiveSpend(match, spend);
  if (!derived) return null;
  const entries = await engine.utxosAt(rpc, matchAddress(derived));
  const hit = entries.find(
    (e) =>
      (!spend.txid || engine.entryTxId(e) === spend.txid) &&
      engine.entryCovenantId(e) === match.covenantId,
  );
  if (!hit) return null;
  const p2Profile = spend.kind === "join" ? engine.profileFromPayload(spend.payload) : null;
  return {
    ...engine.withEntry(derived, hit),
    ...(p2Profile && { profiles: { ...match.profiles, p2: p2Profile } }),
  };
}

/** Where a match stands after replaying the chain from a checkpoint:
 *  - current   nothing spent the game UTXO
 *  - advanced  continuations moved it; `match` is the newest state reached
 *  - ended     a terminal door spent it; `match` is the state it spent
 *  - unknown   the game UTXO is gone and nothing traceable explains it yet */
export type Followed =
  | { status: "current" | "advanced" | "unknown"; match: Match }
  | { status: "ended"; match: Match; spend: engine.SpendInfo };

/**
 * Replay what the chain did to a match since `lowHash`, through any number
 * of transitions: every ACCEPTED spend of the lineage, in order. Each
 * continuation is re-derived by the mode and checked against the address the
 * spending transaction actually paid, so a successor that was spent onward
 * before this client looked (an opponent's commit and their reveal a second
 * later) is followed rather than lost. The head is confirmed live on the
 * UTXO index before it counts as current.
 */
export async function followChain(rpc: Rpc, match: Match, lowHash: string): Promise<Followed> {
  const mode = modeOf(match);
  const { spends } = await engine.lineageSpends(rpc, match.txid, lowHash);
  const accepted = await engine.acceptedOrLive(rpc, lowHash, spends);
  let cur = match;
  let hops = 0;
  const stuck = (): Followed => ({ status: hops ? "advanced" : "unknown", match: cur });
  for (;;) {
    const raw = spends.find((s) => s.prev === cur.txid && accepted.has(s.txid));
    if (!raw) break;
    const spend = engine.spendInfo(raw, engine.entryTags(mode.actorOf(cur)));
    if (!spend) return stuck();
    let base = cur;
    if (base.acceptedDaa === undefined && mode.needsAcceptedDaa?.(base, spend)) {
      const at = accepted.get(base.txid);
      const daa = at
        ? await engine.chainBlockDaa(rpc, at)
        : at === null
          ? null // accepted by the virtual only: its entry would carry the stamp
          : await engine.acceptedDaaOf(rpc, base.txid, loadCheckpoint(base.covenantId) ?? lowHash);
      if (daa === null) return stuck();
      base = { ...base, acceptedDaa: daa };
    }
    const next = mode.rederiveSpend(base, spend);
    if (!next) {
      // A join is a continuation whatever the mode's classifier says (it
      // only sorts round doors); one that won't re-derive is unexplained.
      if (spend.kind !== "join" && mode.classifySpend(spend) === "terminal")
        return { status: "ended", match: cur, spend };
      return stuck();
    }
    // The transaction paid output 0 to the successor's address: our
    // re-derivation is the state the covenant authorized.
    if (raw.out0Address !== null && raw.out0Address !== matchAddress(next)) return stuck();
    // A chain block's score, or none yet for a virtual-only acceptance (the
    // head's UTXO entry supplies it below; an inner hop is always older).
    const at = accepted.get(raw.txid);
    const daa = at ? await engine.chainBlockDaa(rpc, at) : null;
    const p2Profile = spend.kind === "join" ? engine.profileFromPayload(spend.payload) : null;
    cur = {
      ...engine.withoutEntry(next),
      txid: raw.txid,
      value: raw.out0Value ?? next.value,
      ...(daa !== null && { acceptedDaa: daa }),
      ...(p2Profile && { profiles: { ...match.profiles, p2: p2Profile } }),
    };
    hops++;
  }
  const entry = await engine.fetchGameUtxo(rpc, mode, cur);
  if (entry) return { status: hops ? "advanced" : "current", match: engine.withEntry(cur, entry) };
  return stuck();
}

/**
 * The blind-phase catch-up: replay the chain from `lowHash` and return the
 * newest state it reaches, or null when nothing moved or the match ended.
 */
export async function discoverAdvance(
  rpc: Rpc,
  match: Match,
  lowHash: string,
): Promise<Match | null> {
  const followed = await followChain(rpc, match, lowHash);
  return followed.status === "advanced" ? followed.match : null;
}

/**
 * After submitting a terminal spend: wait until the chain says how the game
 * UTXO was actually spent. A mempool accepting our transaction proves
 * nothing — a late continuation (the opponent's resolve after the reveal
 * grace) can still win the input through another node. Resolves "ended"
 * with the accepted terminal spend (ours or not), "advanced" when a
 * continuation won, and null when nothing settled within the wait (the
 * watcher keeps following).
 */
export async function awaitSettlement(
  rpc: Rpc,
  match: Match,
  lowHash: string,
  waitMs = 60_000,
): Promise<Followed | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const followed = await followChain(rpc, match, lowHash).catch(() => null);
    if (followed && (followed.status === "ended" || followed.status === "advanced"))
      return followed;
    await engine.sleep(1000);
  }
  return null;
}

/**
 * A pasted catch-up link, believed only as far as the chain backs it: its
 * state must be the live covenant UTXO of this very match, and fresher than
 * what we track. The link comes from the opponent — the one party who gains
 * from blinding us with a decoy.
 */
export async function verifyImport(rpc: Rpc, current: Match, imported: Match): Promise<Match> {
  if (imported.covenantId !== current.covenantId)
    throw new Error("That link is for a different game.");
  const entry = await engine.fetchGameUtxo(rpc, modeOf(imported), imported);
  if (!entry) throw new Error("That link doesn't show the game's current state.");
  const verified = engine.withEntry(imported, entry);
  if (modeOf(current).progress(verified) < modeOf(current).progress(current))
    throw new Error("That link is older than the game you have.");
  return verified;
}

/** Re-exported for the watcher's ending classification. */
export { modeOf } from "../modes/registry";
