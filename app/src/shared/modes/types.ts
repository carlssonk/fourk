/**
 * The game-mode contract. A mode owns everything that differs between rule
 * sets: script derivation, selector tables, successor enumeration, spend
 * re-derivation, turn semantics, and (in later layers) the view-model and
 * player actions. The engine (lib/engine.ts) and the app-facing facade
 * (lib/covenant.ts) are generic over this interface; adding a mode means
 * adding a module under shared/modes/ and registering it — plus the two
 * inherently shared wire-format arms (share-code mode byte, JSON fields).
 */

import type { ModeEngine, PrivateKey, Rpc, SpendInfo } from "../lib/engine";
import type { State } from "../lib/game";
import type { Match } from "../lib/match";

export type GameModeKey = "classic" | "fourk";

export interface ModeMeta {
  key: GameModeKey;
  /** Picker chip label ("Fourk", "Classic"). */
  label: string;
  /** Picker description under the chips. */
  blurb: string;
  /** Invite-screen sentence prefix, ending where the colour phrase starts. */
  inviteBlurb: string;
  /** "{duration} per {noun}" on the invite screen. */
  moveNoun: string;
}

/** How the watcher should treat a discovered (or undiscoverable) spend when
 * successor adoption failed: a continuation means "retry later", a terminal
 * means "classify the ending". */
export type SpendClass = "continuation" | "terminal";

// --- View surface (React-free: plain data the UI renders) --------------------

export interface ViewCtx {
  myPk: string;
  role: "p1" | "p2" | "spectator";
  /** The local move/round-clock estimate has lapsed. */
  clockExpired: boolean;
  busy: boolean;
  /** The optimistic column keyed to the current game UTXO, or null. Classic
   * recomputes the optimistic board from it; fourk shows the sealed pick. */
  pendingCol: number | null;
  result: string | null;
}

export interface StatusSegment {
  text: string;
  bold?: boolean;
}

export interface StatusDescriptor {
  segments: StatusSegment[];
  /** "danger" renders red; "dim" renders muted. */
  tone?: "danger" | "dim";
  /** Show the little disc spinner before the text. */
  spinner?: boolean;
}

export interface SeatView {
  active: boolean;
  showClock: boolean;
  /** This seat's disc lands underneath if both players pick the same column
   * this round (fourk's alternating collision priority). */
  collisionPriority?: boolean;
}

export interface ModeView {
  /** Live-play status. The UI renders the shared branches itself
   * (connecting, open, result, board-full) and consults this otherwise. */
  status: StatusDescriptor;
  seats: [SeatView, SeatView];
  board: {
    /** What to draw — the optimistic board in classic, the real one in fourk. */
    shownState: State;
    interactive: boolean;
    nextDisc: 1 | 2 | "both" | null;
    /** Which disc lands underneath on a same-column collision this round —
     * orders the "both" on-deck pair (fourk only). */
    priorityDisc?: 1 | 2;
    /** Hover-ghost disc override (fourk: the local player's own colour). */
    ghostDisc?: 1 | 2;
    /** Fourk's sealed pick column (persisted or optimistic), or null. */
    myPick: number | null;
  };
  /** Show the "Time's up — claim the win" button. */
  canClaimTimeout: boolean;
}

export type DropResult =
  | { kind: "continued"; match: Match }
  | { kind: "ended"; match: Match; message: string };

// --- Autopilot: duties a client performs without being asked -----------------
//
// One driver (useAutopilot) runs every mode's automatic actions with shared
// semantics: fire once per guard scope, tolerate losing the race to the
// opponent's client, resync-and-retry on crossed transactions.

export interface AutoCtx {
  myPk: string;
  role: "p1" | "p2";
}

export type AutoOutcome =
  | { kind: "advanced"; match: Match }
  | { kind: "finished"; message: string; match?: Match };

export interface AutoAction {
  key: string;
  /** Guard scope: fire once per game UTXO (round duties) or once per match
   * (terminal cranks). */
  oncePer: "utxo" | "match";
  /** Hold back this long after the duty is first seen (fourk's reveal
   * etiquette: the non-priority player yields the first reveal). */
  delayMs?: number;
  /** Dynamic schedule instead of an immediate run (sudden death: the DAA
   * distance to the deadline). Skipped when it exceeds the timer cap. */
  scheduleMs?(rpc: Rpc): Promise<number>;
  run(rpc: Rpc, key: PrivateKey, m: Match): Promise<AutoOutcome>;
  /** finish() message when the post-failure sync says "terminated" — the
   * opponent's client cranked the same permissionless door first. Omitted =
   * stay silent and let the watcher classify the ending. */
  onTerminated?: string;
}

export interface ModeActions {
  /** The column click: classic plays a move (or a winning_move that ends the
   * game); fourk seals a commitment (persisting its salt first). */
  drop(rpc: Rpc, key: PrivateKey, m: Match, col: number): Promise<DropResult>;
  /** The timeout door: classic claim_forfeit; fourk claim_timeout. */
  claimTimeout(rpc: Rpc, key: PrivateKey, m: Match): Promise<string>;
}

export interface GameMode extends ModeEngine {
  meta: ModeMeta;

  // --- view surface ---
  /** Has anything been staked on the current obligation clock? (Feeds the
   * move-clock hook; classic: a disc has dropped; fourk: the round has a
   * commitment or is past the commit phase.) */
  roundStarted(m: Match): boolean;
  /** Joined but still unwindable via dissolve (both stakes back). */
  inLobby(m: Match): boolean;
  view(m: Match, ctx: ViewCtx): ModeView;
  /** Friendly ending copy for a discovered terminal spend. */
  describeEnd(spend: SpendInfo | null, m: Match, myPk: string): string;
  /** The final board snapshot to record with an ending (classic replays a
   * discovered winning move's last disc; fourk boards are already final). */
  finalSnapshot(spend: SpendInfo | null, m: Match): Match;

  actions: ModeActions;
  /** Pending automatic duties for the autopilot driver. */
  autoActions(m: Match, ctx: AutoCtx): AutoAction[];

  /** Mode-specific Match fields stamped on a fresh genesis. */
  genesisFields(): Partial<Match>;
  /** Mode-specific fields the join successor carries. */
  joinFields(m: Match): Partial<Match>;
  /** Enumerable successor snapshots of a live match, as full Matches with
   * stale txid/value (the sync engine attaches the on-chain hit). Empty in
   * blind phases — see canEnumerate. */
  successors(m: Match): Match[];
  /** Can successors() see every continuation from here? False = a blind
   * phase (a successor embeds data we can't know); the spend must be traced
   * and re-derived instead. */
  canEnumerate(m: Match): boolean;
  /** Rebuild the successor a traced continuation spend produced, from its
   * sig-script pushes/args. Null = terminal spend, unusable pushes, or a
   * spend that contradicts our snapshot. The caller verifies the derived
   * address actually holds the covenant UTXO before adopting. */
  rederiveSpend(m: Match, spend: SpendInfo): Match | null;
  /** Classify a traced spend (null = untraceable) for the watcher. */
  classifySpend(spend: SpendInfo | null): SpendClass;
  /** Monotone progress key — which of two snapshots of the same match is
   * fresher. */
  progress(m: Match): number;
  /** Does pkHex owe this match an action right now? */
  isActionable(m: Match, pkHex: string): boolean;

  /** Called after the stored-match list is pruned/saved, with the surviving
   * covenant ids — a mode GCs any local per-match secrets. */
  onMatchesPruned?(keptCovenantIds: string[]): void;
}
