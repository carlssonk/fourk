/**
 * Covenant state for one fourk-mode (simultaneous) match.
 *
 * Play proceeds in rounds instead of turns: both players commit to a column
 * (a blake2b hash, so neither can peek), then both reveal, and the second
 * reveal drops both discs at once. The state therefore carries what classic
 * derives from moveCount — round progress and each player's standing round
 * obligation — as real fields:
 *   - commit1/commit2: one 32-byte commitment slot per player; ZERO_HASH
 *     means "none yet". The first reveal zeroes the revealer's slot.
 *   - reveal1/reveal2: 0 = not revealed, else column + 1. At most one is
 *     ever set in a stored state — the second reveal resolves the round in
 *     the same transition and clears all four slots.
 * The round sub-phase stays derived (see roundPhase): commits only = COMMIT,
 * both commits = REVEAL, one reveal = RESOLVE.
 */

import {
  CELLS,
  COLS,
  DEADLINE_LIMIT,
  EMPTY,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  P1_DISC,
  P2_DISC,
  ROWS,
  type PubKey,
  ZERO_PK,
  cellIndex,
  isPubKey,
} from "../state.js";

/** 32-byte "no commitment" sentinel, lowercase hex (like ZERO_PK). */
export type Commitment = string;
export const ZERO_HASH: Commitment = "00".repeat(32);

export interface SimulState {
  /** Same layout as classic: column-major, cell (col, row) = board[col * ROWS + row]. */
  board: Uint8Array;
  /** Completed rounds. Collision priority = round % 2 (0 → p1). */
  round: number;
  p1: PubKey;
  /** ZERO_PK until a second player joins. */
  p2: PubKey;
  /** blake2b256(colByte || salt32) per player; ZERO_HASH = no commitment. */
  commit1: Commitment;
  commit2: Commitment;
  /** 0 = not revealed this round, else revealed column + 1. */
  reveal1: number;
  reveal2: number;
  /**
   * The challenge window: 0 = normal play; 1/2 = that color's owner proved a
   * line via claimWin and the pot is pending theirs. The opponent (anyone,
   * in fact — it is permissionless) has one move clock to present the OTHER
   * line via claimSplit (the double-win contest); after `this.age >=
   * moveTimeout` the pending winner sweeps. This turns the double-win
   * mempool race into a full block-time window, and consensus itself (the
   * sweep's sequence lock) rejects an early sweep.
   */
  pendingWin: number;
  /** Per-player stake in sompi. Pot = 2 * stake once joined. */
  stake: bigint;
  /** Per-obligation forfeit timeout in DAA blocks; chosen at creation. */
  moveTimeout: number;
  /** Absolute DAA score for sudden death. Mandatory (join refuses 0): the
   * one permissionless exit that keeps a pot from being stranded forever. */
  deadline: number;
}

export function newSimulMatch(
  p1: PubKey,
  stake: bigint,
  moveTimeout: number,
  deadline: number,
): SimulState {
  if (!isPubKey(p1) || p1 === ZERO_PK) throw new Error("invalid p1 pubkey");
  if (stake <= 0n) throw new Error("stake must be positive");
  if (!Number.isInteger(moveTimeout) || moveTimeout < MIN_MOVE_TIMEOUT_DAA)
    throw new Error("move timeout below minimum");
  if (moveTimeout > MAX_MOVE_TIMEOUT_DAA) throw new Error("move timeout above maximum");
  if (!Number.isInteger(deadline) || deadline <= 0 || deadline >= DEADLINE_LIMIT)
    throw new Error("bad deadline");
  return {
    board: new Uint8Array(CELLS),
    round: 0,
    p1,
    p2: ZERO_PK,
    commit1: ZERO_HASH,
    commit2: ZERO_HASH,
    reveal1: 0,
    reveal2: 0,
    pendingWin: 0,
    stake,
    moveTimeout,
    deadline,
  };
}

/** The color whose claimWin opened the current challenge window, if any. */
export function pendingWinner(s: SimulState): 0 | 1 | null {
  return s.pendingWin === 0 ? null : ((s.pendingWin - 1) as 0 | 1);
}

export function isSimulOpen(s: SimulState): boolean {
  return s.p2 === ZERO_PK;
}

export function simulPot(s: SimulState): bigint {
  return isSimulOpen(s) ? s.stake : 2n * s.stake;
}

/** Who lands lower when both players pick the same column this round. */
export function priorityPlayer(round: number): 0 | 1 {
  return (round % 2) as 0 | 1;
}

export function commitOf(s: SimulState, player: 0 | 1): Commitment {
  return player === 0 ? s.commit1 : s.commit2;
}

export function revealOf(s: SimulState, player: 0 | 1): number {
  return player === 0 ? s.reveal1 : s.reveal2;
}

export type RoundPhase = "commit" | "reveal" | "resolve";

/**
 * Derived sub-phase of the current round. Every reachable live state maps to
 * exactly one: a set reveal slot means one player revealed and the other owes
 * a resolve; both commitments set means both owe a reveal; otherwise commits
 * are still being collected.
 */
export function roundPhase(s: SimulState): RoundPhase {
  if (s.reveal1 !== 0 || s.reveal2 !== 0) return "resolve";
  if (s.commit1 !== ZERO_HASH && s.commit2 !== ZERO_HASH) return "reveal";
  return "commit";
}

/**
 * Full = every column topped out. The simul draw door keys on the board, not
 * a move count: colliding picks on a column's last slot drop only the
 * priority disc, so total discs is not a linear function of rounds — but the
 * board itself still fills monotonically (every round lands at least one).
 */
export function isBoardFull(board: Uint8Array): boolean {
  for (let c = 0; c < COLS; c++) {
    if (board[cellIndex(c, ROWS - 1)] === EMPTY) return false;
  }
  return true;
}

// --- Canonical serialization -------------------------------------------------
//
// Fixed layout, one valid encoding per state, mirroring ../state.ts.
// Layout: board[42] | round u8 | p1[32] | p2[32] | commit1[32] | commit2[32]
//       | reveal1 u8 | reveal2 u8 | pendingWin u8 | stake u64le
//       | moveTimeout u32le | deadline u64le.

export const SIMUL_STATE_BYTES = CELLS + 1 + 32 + 32 + 32 + 32 + 1 + 1 + 1 + 8 + 4 + 8; // 194

export function encodeSimulState(s: SimulState): Uint8Array {
  const out = new Uint8Array(SIMUL_STATE_BYTES);
  out.set(s.board, 0);
  out[CELLS] = s.round;
  out.set(hexToBytes(s.p1), CELLS + 1);
  out.set(hexToBytes(s.p2), CELLS + 33);
  out.set(hexToBytes(s.commit1), CELLS + 65);
  out.set(hexToBytes(s.commit2), CELLS + 97);
  out[CELLS + 129] = s.reveal1;
  out[CELLS + 130] = s.reveal2;
  out[CELLS + 131] = s.pendingWin;
  const view = new DataView(out.buffer);
  view.setBigUint64(CELLS + 132, s.stake, true);
  view.setUint32(CELLS + 140, s.moveTimeout, true);
  view.setBigUint64(CELLS + 144, BigInt(s.deadline), true);
  return out;
}

export function decodeSimulState(buf: Uint8Array): SimulState {
  if (buf.length !== SIMUL_STATE_BYTES) throw new Error("bad state length");
  const board = buf.slice(0, CELLS);
  for (const b of board) {
    if (b !== EMPTY && b !== P1_DISC && b !== P2_DISC) throw new Error("bad cell value");
  }
  const reveal1 = buf[CELLS + 129]!;
  const reveal2 = buf[CELLS + 130]!;
  if (reveal1 > COLS || reveal2 > COLS) throw new Error("bad reveal value");
  const pendingWin = buf[CELLS + 131]!;
  if (pendingWin > 2) throw new Error("bad pending win value");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    board,
    round: buf[CELLS]!,
    p1: bytesToHex(buf.slice(CELLS + 1, CELLS + 33)),
    p2: bytesToHex(buf.slice(CELLS + 33, CELLS + 65)),
    commit1: bytesToHex(buf.slice(CELLS + 65, CELLS + 97)),
    commit2: bytesToHex(buf.slice(CELLS + 97, CELLS + 129)),
    reveal1,
    reveal2,
    pendingWin,
    stake: view.getBigUint64(CELLS + 132, true),
    moveTimeout: view.getUint32(CELLS + 140, true),
    deadline: Number(view.getBigUint64(CELLS + 144, true)),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
