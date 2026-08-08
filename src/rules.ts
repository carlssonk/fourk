/**
 * The complete rulebook: eight entrypoints, each a pure function
 * (state, ctx, args) → successor state | terminal payout, throwing on any
 * illegal transition. This is the single source of truth the Silverscript
 * contract will be ported from — every `req(...)` here becomes a `require(...)`
 * there, and every returned value becomes an enforced output.
 *
 * Ctx models exactly what the covenant can observe about its spending
 * transaction: which pubkey authorized the spend (checkSig) and how old the
 * state UTXO is (`this.age`, in DAA blocks). Output values/scripts are modeled
 * by the return types: a `State` return means "one covenant successor output
 * carrying this state and the full pot"; a `Payout[]` return means the
 * covenant terminates and these outputs must appear.
 */

import {
  CELLS,
  COLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  ROWS,
  type State,
  type PubKey,
  ZERO_PK,
  cellIndex,
  discOf,
  heightOf,
  isOpen,
  isPubKey,
  playerToMove,
  pot,
  pubkeyOf,
} from "./state.js";

export interface Ctx {
  /** The pubkey whose signature authorizes this spend (models checkSig). */
  signer: PubKey;
  /** Age of the state UTXO in DAA blocks (models `this.age`). */
  utxoAge: number;
  /** Chain DAA score proven reached by the spend's locktime (models
   * `tx.time`) — the claimant can understate it, never overstate. */
  txTime: number;
}

export interface Payout {
  to: PubKey;
  amount: bigint;
}

/**
 * Win witness: the first cell of the line plus a direction index. Four cells
 * are derived as (col + k*dc, row + k*dr) for k in 0..3 — non-contiguous or
 * bent "lines" are unrepresentable by construction, so the covenant only has
 * to bounds-check and compare four cells.
 */
export interface LineWitness {
  col: number;
  row: number;
  /** Index into DIRS: 0 = E (horizontal), 1 = N (vertical), 2 = NE, 3 = SE. */
  dir: number;
}

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function req(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

// --- Open phase --------------------------------------------------------------

/**
 * Player 2 joins by adding a matching stake. On-chain this transition also
 * requires the successor output's value to be 2 * stake (the joiner brings the
 * second stake as an additional input).
 */
export function join(s: State, ctx: Ctx): State {
  req(isOpen(s), "match is not open");
  req(isPubKey(ctx.signer) && ctx.signer !== ZERO_PK, "invalid joiner pubkey");
  // Playing yourself is pointless but a same-key match is also degenerate
  // for every door keyed on "the other player" — rule it out at the gate.
  req(ctx.signer !== s.p1, "cannot join your own match");
  // Genesis sanity the joiner relies on: a near-instant forfeit clock would
  // make the game a trap, so a genesis below the floor is unjoinable — and a
  // decades-long clock would turn claimForfeit into a hostage lock, so a
  // genesis above the ceiling is unjoinable too.
  req(s.moveTimeout >= MIN_MOVE_TIMEOUT_DAA, "move timeout below minimum");
  req(s.moveTimeout <= MAX_MOVE_TIMEOUT_DAA, "move timeout above maximum");
  // A deadline is mandatory: suddenDeath is the one permissionless exit every
  // match is guaranteed, so a pot can never be stranded by two vanished
  // players (every other mid-game door needs a player's signature). It must
  // also stay below the consensus lock-time threshold, where a "DAA score"
  // would silently become a unix-ms timestamp. What script CANNOT check is
  // that the deadline is still in the future (a locktime proves time passed,
  // never time remaining) — that check belongs to the joiner's client.
  req(s.deadline > 0, "no game deadline set");
  req(s.deadline < DEADLINE_LIMIT, "deadline out of range");
  return { ...s, board: s.board.slice(), p2: ctx.signer };
}

/**
 * Player 1 reclaims their stake while the match is still open. No deadline:
 * if a join races this cancel, exactly one spend of the match UTXO wins and
 * the loser's transaction is simply rejected — nobody loses funds.
 */
export function cancel(s: State, ctx: Ctx): Payout[] {
  req(isOpen(s), "match is not open");
  req(ctx.signer === s.p1, "only p1 can cancel");
  return [{ to: s.p1, amount: s.stake }];
}

/**
 * Either player unwinds a joined match before the first disc falls: both
 * stakes return to their owners, enforced as claim_draw-style pinned payouts
 * (the signer is refunding the OTHER player's money too, so their signature
 * cannot be allowed to direct it). This is P1 kicking the joiner and P2
 * leaving an unstarted lobby, through one door — and it is what lets
 * claimForfeit demand a begun game: nobody can be held hostage at move zero.
 */
export function dissolve(s: State, ctx: Ctx): Payout[] {
  req(!isOpen(s), "match not started");
  req(s.moveCount === 0, "game has begun");
  req(ctx.signer === s.p1 || ctx.signer === s.p2, "only a player can dissolve");
  // The joiner's exit waits out one move clock (the state UTXO was created
  // by the join, so its age is exactly time-since-join): an instant
  // join-and-dissolve would let a stranger with the invite link kill
  // lobbies for the cost of two fees. P1's kick stays instant — it refunds
  // the joiner, so nobody is held by it.
  if (ctx.signer === s.p2) req(ctx.utxoAge >= s.moveTimeout, "joiner must wait out the move clock");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

// --- Playing phase -----------------------------------------------------------

/**
 * Drop a disc in a column. Gravity makes legality trivial: your turn, column
 * in range, column not full. The successor is exactly the old board plus one
 * disc, moveCount incremented. Note: a plain move never checks for wins — a
 * player who completes four-in-a-row with a plain move has (foolishly) chosen
 * not to claim it now; see winningMove.
 */
export function move(s: State, ctx: Ctx, col: number): State {
  const h = validateMove(s, ctx, col);
  const board = s.board.slice();
  board[cellIndex(col, h)] = discOf(playerToMove(s));
  return { ...s, board, moveCount: s.moveCount + 1 };
}

/**
 * Terminal door 1: play a disc AND prove it leaves four-in-a-row of your
 * color on the board. Verification is witness-based — the mover points at the
 * line, the covenant checks four cells. Merging the win claim into the move
 * (rather than a separate claim_win phase) means a completed win can never sit
 * unclaimed on the board while the opponent races toward a draw.
 *
 * The line is not required to contain the disc just played: if you left an
 * earlier win unclaimed, any move of yours may claim it.
 */
export function winningMove(s: State, ctx: Ctx, col: number, line: LineWitness): Payout[] {
  const h = validateMove(s, ctx, col);
  const mover = playerToMove(s);
  const board = s.board.slice();
  board[cellIndex(col, h)] = discOf(mover);
  req(verifyLine(board, discOf(mover), line), "invalid win witness");
  return [{ to: pubkeyOf(s, mover), amount: pot(s) }];
}

/**
 * Terminal door 2: board full, pot splits. The covenant cannot know whether an
 * unclaimed win exists on the board (that would be the 69-line scan this whole
 * design avoids) — but with winningMove available on every turn, an unclaimed
 * win at move 42 means its owner declined to claim it, twice over.
 * Permissionless: outputs are enforced, so anyone may crank it.
 */
export function claimDraw(s: State, _ctx: Ctx): Payout[] {
  req(!isOpen(s), "match not started");
  req(s.moveCount === CELLS, "board not full");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

/**
 * Terminal door 3: the player to move has let the state UTXO age past the
 * timeout; the waiting player takes the pot. Load-bearing, not an edge case —
 * without it a losing player holds the pot hostage by going silent.
 *
 * Only once the game has begun: at move zero P1 may not even know a joiner
 * arrived (invite links are taken at any hour), so an unmoved game is
 * dissolvable by either player instead of forfeitable — see dissolve.
 */
export function claimForfeit(s: State, ctx: Ctx): Payout[] {
  req(!isOpen(s), "match not started");
  req(s.moveCount > 0, "game not begun — dissolve instead");
  req(s.moveCount < CELLS, "board full — claim the draw instead");
  const waiting = (1 - playerToMove(s)) as 0 | 1;
  req(ctx.signer === pubkeyOf(s, waiting), "only the waiting player can claim forfeit");
  req(ctx.utxoAge >= s.moveTimeout, "move deadline not expired");
  return [{ to: pubkeyOf(s, waiting), amount: pot(s) }];
}

/**
 * Terminal door 4: the whole game outlived its creation-time cap — the pot
 * splits evenly, exactly like a draw. Neither player gains from engineering
 * this, so it is permissionless (payouts pinned, anyone may crank) and legal
 * even on an unmoved board: it doubles as cleanup for abandoned lobbies.
 * A per-move flat timeout alone leaves total game length unbounded (~T per
 * move, every move); the deadline is what bounds the game as a whole.
 */
export function suddenDeath(s: State, ctx: Ctx): Payout[] {
  req(!isOpen(s), "match not started");
  req(s.deadline > 0, "no game deadline set");
  req(ctx.txTime >= s.deadline, "game deadline not reached");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

// --- Shared validation -------------------------------------------------------

/** Common legality for move/winningMove; returns the landing row. */
function validateMove(s: State, ctx: Ctx, col: number): number {
  req(!isOpen(s), "match not started");
  req(s.moveCount < CELLS, "board full");
  req(ctx.signer === pubkeyOf(s, playerToMove(s)), "not your turn");
  req(isInt(col) && col >= 0 && col < COLS, "column out of range");
  const h = heightOf(s.board, col);
  req(h < ROWS, "column full");
  return h;
}

/** The dozen comparisons that replace the 69-line board scan. */
export function verifyLine(board: Uint8Array, disc: number, w: LineWitness): boolean {
  if (!isInt(w.col) || !isInt(w.row) || !isInt(w.dir)) return false;
  const d = DIRS[w.dir];
  if (!d) return false;
  const [dc, dr] = d;
  for (let k = 0; k < 4; k++) {
    const c = w.col + k * dc;
    const r = w.row + k * dr;
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
    if (board[cellIndex(c, r)] !== disc) return false;
  }
  return true;
}
