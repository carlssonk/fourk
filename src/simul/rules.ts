/**
 * The fourk-mode rulebook: simultaneous Connect Four by commit-reveal.
 * Twelve entrypoints, each a pure function (state, ctx, args) → successor
 * state | terminal payout, throwing on any illegal transition — the same
 * contract as ../rules.ts, and like it the single source of truth the Argent
 * actors are ported from.
 *
 * A round is: both players commit blake2b(colByte || salt) in either order,
 * both reveal in either order, and the second reveal ("resolve") drops both
 * discs in one transition. Colliding picks stack in the same column with the
 * round's priority player (round % 2) underneath; on a column's last slot the
 * non-priority disc vanishes instead. A commit to a column already full is
 * legal to make but impossible to reveal — its owner loses through
 * claimTimeout, which is why the UI never offers full columns.
 *
 * Because two discs land at once, the winner of a round need not be the
 * player who resolved it — so win claims are their own doors, keyed to the
 * witness line's OWNER. The covenant cannot prove a line's ABSENCE (no board
 * scan, by design), so a one-line claimWin cannot be trusted to pay out
 * immediately: instead it opens a CHALLENGE WINDOW (pendingWin in state) of
 * one move clock, during which the permissionless claimSplit — legal on
 * pending states precisely for this — converts a hidden double win into the
 * fair split; sweepWin pays the winner once the window lapses. The old
 * "greedy claimWin races honest claimSplit in the mempool" edge is gone: the
 * race is now a full block-time window, and consensus itself (the sweep's
 * sequence lock) rejects an early sweep.
 */

import {
  COLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  P1_DISC,
  P2_DISC,
  ROWS,
  type PubKey,
  ZERO_PK,
  cellIndex,
  discOf,
  heightOf,
  isPubKey,
} from "../state.js";
import { type Ctx, type LineWitness, type Payout, verifyLine } from "../rules.js";
import {
  type Commitment,
  type SimulState,
  ZERO_HASH,
  commitOf,
  isBoardFull,
  isSimulOpen,
  pendingWinner,
  priorityPlayer,
  revealOf,
  simulPot,
} from "./state.js";
import { commitmentOf } from "./hash.js";

function req(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

function isCommitment(h: string): boolean {
  return /^[0-9a-f]{64}$/.test(h);
}

function playerOf(s: SimulState, signer: PubKey): 0 | 1 {
  req(signer === s.p1 || signer === s.p2, "only a player may act");
  return signer === s.p1 ? 0 : 1;
}

function simulPubkeyOf(s: SimulState, player: 0 | 1): PubKey {
  return player === 0 ? s.p1 : s.p2;
}

// --- Open phase --------------------------------------------------------------

/** Identical to classic join: p2 adds a matching stake (successor value = 2 * stake),
 * with the same genesis sanity gates — clock floor and ceiling, and a
 * mandatory in-range deadline (see ../rules.ts join for the full rationale;
 * in fourk mode a strandable pot is even easier to reach, because
 * claimTimeout pays one SPECIFIC player, who may be the one who vanished). */
export function join(s: SimulState, ctx: Ctx): SimulState {
  req(isSimulOpen(s), "match is not open");
  req(isPubKey(ctx.signer) && ctx.signer !== ZERO_PK, "invalid joiner pubkey");
  req(ctx.signer !== s.p1, "cannot join your own match");
  req(s.moveTimeout >= MIN_MOVE_TIMEOUT_DAA, "move timeout below minimum");
  req(s.moveTimeout <= MAX_MOVE_TIMEOUT_DAA, "move timeout above maximum");
  req(s.deadline > 0, "no game deadline set");
  req(s.deadline < DEADLINE_LIMIT, "deadline out of range");
  return { ...s, board: s.board.slice(), p2: ctx.signer };
}

/** Identical to classic cancel: p1 reclaims an unjoined stake. */
export function cancel(s: SimulState, ctx: Ctx): Payout[] {
  req(isSimulOpen(s), "match is not open");
  req(ctx.signer === s.p1, "only p1 can cancel");
  return [{ to: s.p1, amount: s.stake }];
}

/**
 * Either player unwinds a joined match nothing has happened in — no round
 * completed AND no commitment on the table (a lone commitment is a one-sided
 * obligation and belongs to claimTimeout). Same anti-grief shape as classic:
 * the joiner's exit waits out one clock, p1's kick is instant.
 */
export function dissolve(s: SimulState, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  // Unreachable in honest play (a line needs rounds), but a directly-created
  // covenant UTXO could carry it — belt and braces.
  req(s.pendingWin === 0, "win claim pending");
  req(s.round === 0, "game has begun");
  req(s.commit1 === ZERO_HASH && s.commit2 === ZERO_HASH, "game has begun");
  req(s.reveal1 === 0 && s.reveal2 === 0, "game has begun");
  req(ctx.signer === s.p1 || ctx.signer === s.p2, "only a player can dissolve");
  if (ctx.signer === s.p2) req(ctx.utxoAge >= s.moveTimeout, "joiner must wait out the move clock");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

// --- The round: commit → reveal → resolve ------------------------------------

/**
 * Stake a sealed column pick. Order-free: each player owns one slot, and the
 * covenant only ever compares your reveal against your own slot, so copying
 * the opponent's visible hash buys nothing (you'd have to reveal their exact
 * column AND salt — a collision round you chose blind).
 */
export function commit(s: SimulState, ctx: Ctx, h: Commitment): SimulState {
  req(!isSimulOpen(s), "match not started");
  req(s.pendingWin === 0, "win claim pending");
  req(!isBoardFull(s.board), "board full — claim the draw instead");
  req(s.reveal1 === 0 && s.reveal2 === 0, "commit phase is over");
  const player = playerOf(s, ctx.signer);
  req(commitOf(s, player) === ZERO_HASH, "already committed");
  req(isCommitment(h) && h !== ZERO_HASH, "invalid commitment");
  const next = { ...s, board: s.board.slice() };
  if (player === 0) next.commit1 = h;
  else next.commit2 = h;
  return next;
}

/**
 * First reveal of the round: prove your sealed pick. Legality of the column
 * (in range, not full in the pre-round board) is enforced HERE, not at
 * commit — the board is public when you commit, so a full-column commitment
 * is a knowingly dead one. The revealer's commitment slot is zeroed so every
 * state keeps an unambiguous derived phase.
 */
export function reveal(s: SimulState, ctx: Ctx, col: number, salt: Uint8Array): SimulState {
  req(!isSimulOpen(s), "match not started");
  req(s.pendingWin === 0, "win claim pending");
  req(s.reveal1 === 0 && s.reveal2 === 0, "round already has a reveal — resolve instead");
  req(s.commit1 !== ZERO_HASH && s.commit2 !== ZERO_HASH, "commit phase not complete");
  const player = playerOf(s, ctx.signer);
  checkReveal(s, player, col, salt);
  const next = { ...s, board: s.board.slice() };
  if (player === 0) {
    next.commit1 = ZERO_HASH;
    next.reveal1 = col + 1;
  } else {
    next.commit2 = ZERO_HASH;
    next.reveal2 = col + 1;
  }
  return next;
}

/**
 * Second reveal: prove your pick and drop BOTH discs. The successor is fully
 * determined — the opponent's column is on the table — so this transition
 * also clears all round slots and bumps the round. Wins created here are
 * claimed through claimWin/claimSplit; the game state itself just continues
 * (a covenant successor exists even on a winning board, exactly as classic
 * lets a win sit unclaimed).
 */
export function resolve(s: SimulState, ctx: Ctx, col: number, salt: Uint8Array): SimulState {
  req(!isSimulOpen(s), "match not started");
  req(s.pendingWin === 0, "win claim pending");
  const player = playerOf(s, ctx.signer);
  req(revealOf(s, player) === 0, "you already revealed — opponent must resolve");
  const other = (1 - player) as 0 | 1;
  const otherReveal = revealOf(s, other);
  req(otherReveal !== 0, "nothing to resolve — reveal instead");
  req(commitOf(s, player) !== ZERO_HASH, "no commitment to resolve");
  checkReveal(s, player, col, salt);
  const board = applyResolution(s.board, s.round, otherReveal - 1, other, col);
  return {
    ...s,
    board,
    round: s.round + 1,
    commit1: ZERO_HASH,
    commit2: ZERO_HASH,
    reveal1: 0,
    reveal2: 0,
  };
}

/** Shared reveal legality: hash preimage, column range, column not full pre-round. */
function checkReveal(s: SimulState, player: 0 | 1, col: number, salt: Uint8Array): void {
  req(isInt(col) && col >= 0 && col < COLS, "column out of range");
  req(salt.length === 32, "bad salt length");
  req(commitmentOf(col, salt) === commitOf(s, player), "wrong column or salt");
  req(heightOf(s.board, col) < ROWS, "column full");
}

/**
 * Both discs land on the pre-round board. Different columns commute; the
 * same column stacks with the round's priority player underneath — and on a
 * column with one free slot, only the priority disc survives (the vanish
 * edge). Exported for the app: this is how successors are enumerated.
 */
export function applyResolution(
  board: Uint8Array,
  round: number,
  colA: number,
  playerA: 0 | 1,
  colB: number,
): Uint8Array {
  const playerB = (1 - playerA) as 0 | 1;
  const next = board.slice();
  if (colA !== colB) {
    next[cellIndex(colA, heightOf(next, colA))] = discOf(playerA);
    next[cellIndex(colB, heightOf(next, colB))] = discOf(playerB);
  } else {
    const h = heightOf(board, colA);
    const lower = priorityPlayer(round);
    next[cellIndex(colA, h)] = discOf(lower);
    if (h + 1 < ROWS) next[cellIndex(colA, h + 1)] = discOf((1 - lower) as 0 | 1);
  }
  return next;
}

// --- Terminal doors ----------------------------------------------------------

/**
 * Door 1: point at four-in-a-row on the CURRENT board and open the challenge
 * window. No disc is played — resolution already landed it — and the
 * resolver need not be the winner, so the claim is keyed to the line's
 * owner: the witness's first cell names the disc color, and that color's
 * player must be the signer.
 *
 * NOT a terminal door: the covenant cannot prove the OTHER line's absence
 * (no board scan, by design), so paying out immediately would let a
 * double-win owner race the honest claimSplit in the mempool — a race a bot
 * always wins. Instead the claim parks the pot in a pending state for one
 * move clock: claimSplit (permissionless, needs both real lines) converts
 * it to the fair split at leisure, and sweepWin pays the winner once the
 * window lapses. The round slots are zeroed — the game is over except for
 * the contest, and a canonical pending state keeps the phase unambiguous.
 */
export function claimWin(s: SimulState, ctx: Ctx, line: LineWitness): SimulState {
  req(!isSimulOpen(s), "match not started");
  req(s.pendingWin === 0, "win claim already pending");
  const disc = discAt(s.board, line);
  req(disc === P1_DISC || disc === P2_DISC, "invalid win witness");
  req(verifyLine(s.board, disc, line), "invalid win witness");
  const owner = (disc - 1) as 0 | 1;
  req(ctx.signer === simulPubkeyOf(s, owner), "not your line");
  return {
    ...s,
    board: s.board.slice(),
    commit1: ZERO_HASH,
    commit2: ZERO_HASH,
    reveal1: 0,
    reveal2: 0,
    pendingWin: disc,
  };
}

/**
 * Terminal door: sweep a pending win whose challenge window has lapsed.
 * Signed by the sole owner of the pot, so funds go wherever they direct.
 * The window is one move clock of UTXO age — consensus itself (the sequence
 * lock) rejects an early sweep, so there is nothing to race.
 */
export function sweepWin(s: SimulState, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  const winner = pendingWinner(s);
  req(winner !== null, "no win claim pending");
  req(ctx.utxoAge >= s.moveTimeout, "challenge window still open");
  req(ctx.signer === simulPubkeyOf(s, winner), "only the pending winner can sweep");
  return [{ to: simulPubkeyOf(s, winner), amount: simulPot(s) }];
}

/**
 * Terminal door 2: the double win — BOTH colors have a line, so the pot
 * splits. Two witnesses, one per color; permissionless (payouts pinned,
 * anyone may crank). Deliberately legal in a pending-win state too: this is
 * the CONTEST that keeps a one-sided claimWin honest, and because the
 * witnesses are computable from the public board, anyone — the opponent's
 * client, an altruistic observer — can fire it inside the window.
 */
export function claimSplit(s: SimulState, _ctx: Ctx, w1: LineWitness, w2: LineWitness): Payout[] {
  req(!isSimulOpen(s), "match not started");
  req(verifyLine(s.board, P1_DISC, w1) && verifyLine(s.board, P2_DISC, w2), "invalid split witnesses");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

/**
 * Terminal door 3: board full, pot splits. Keys on the board itself (simul
 * has no move count): every column topped out. Commits are refused on a full
 * board, so no obligation can be pending here. Permissionless.
 */
export function claimDraw(s: SimulState, _ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  // A pending win outranks the draw: this door is permissionless, and on a
  // full board it would otherwise race half the pot away from a winner
  // whose challenge window is still open.
  req(s.pendingWin === 0, "win claim pending");
  req(isBoardFull(s.board), "board not full");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

/**
 * Terminal door 4: the opponent is late on a one-sided obligation and the
 * compliant player takes the pot. One-sided means: exactly one reveal on the
 * table (the revealer is owed a resolve — this is also what punishes both
 * the peek-then-stall griefer and the unreveable full-column commit), or no
 * reveals and exactly one commitment (the committer is owed a commit).
 * Symmetric silence is nobody's fault — that's splitTimeout.
 */
export function claimTimeout(s: SimulState, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  req(s.pendingWin === 0, "win claim pending — sweep or contest instead");
  req(!isBoardFull(s.board), "board full — claim the draw instead");
  req(ctx.utxoAge >= s.moveTimeout, "round deadline not expired");
  let claimant: 0 | 1;
  if (s.reveal1 !== 0 || s.reveal2 !== 0) {
    claimant = s.reveal1 !== 0 ? 0 : 1;
  } else {
    const oneCommit = (s.commit1 === ZERO_HASH) !== (s.commit2 === ZERO_HASH);
    req(oneCommit, "nobody is late one-sidedly — split instead");
    claimant = s.commit1 !== ZERO_HASH ? 0 : 1;
  }
  req(ctx.signer === simulPubkeyOf(s, claimant), "only the compliant player can claim");
  return [{ to: simulPubkeyOf(s, claimant), amount: simulPot(s) }];
}

/**
 * Terminal door 5: symmetric stall — neither player has committed, or both
 * committed and neither revealed — past the clock. Nobody is more at fault
 * than the other, so the pot splits, permissionless. (A mutual reveal
 * standoff cannot exist: reveals are one-sided by construction.)
 */
export function splitTimeout(s: SimulState, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  // A pending-win state is slot-empty and symmetric-shaped — without this
  // gate, the same clock that opens sweepWin would open a permissionless
  // split of the winner's pot.
  req(s.pendingWin === 0, "win claim pending — sweep or contest instead");
  req(s.reveal1 === 0 && s.reveal2 === 0, "one-sided state — claim the forfeit instead");
  req((s.commit1 === ZERO_HASH) === (s.commit2 === ZERO_HASH), "one-sided state — claim the forfeit instead");
  req(ctx.utxoAge >= s.moveTimeout, "round deadline not expired");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

/**
 * Terminal door 6: the whole game outlived its creation-time cap. Identical
 * to classic sudden death: permissionless even split, legal in any live
 * state, doubles as cleanup for abandoned games.
 */
export function suddenDeath(s: SimulState, ctx: Ctx): Payout[] {
  req(!isSimulOpen(s), "match not started");
  req(s.deadline > 0, "no game deadline set");
  req(ctx.txTime >= s.deadline, "game deadline not reached");
  return [
    { to: s.p1, amount: s.stake },
    { to: s.p2, amount: s.stake },
  ];
}

// --- Shared helpers ----------------------------------------------------------

function discAt(board: Uint8Array, w: LineWitness): number {
  if (!isInt(w.col) || !isInt(w.row)) return 0;
  if (w.col < 0 || w.col >= COLS || w.row < 0 || w.row >= ROWS) return 0;
  return board[cellIndex(w.col, w.row)]!;
}

/** Columns a player may legally commit to this round (pre-round board). */
export function legalSimulColumns(s: SimulState): number[] {
  const open: number[] = [];
  for (let c = 0; c < COLS; c++) if (heightOf(s.board, c) < ROWS) open.push(c);
  return open;
}
