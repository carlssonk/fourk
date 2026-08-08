/**
 * Covenant state for one Connect Four match.
 *
 * This mirrors, field for field, what will live in the Silverscript contract's
 * state (spliced into the P2SH redeem-script preimage). Everything not listed
 * here is deliberately derived, because derived facts cost nothing on-chain:
 *   - phase:  OPEN iff p2 == ZERO_PK, PLAYING otherwise (terminal states have
 *             no successor UTXO at all — the covenant ends).
 *   - turn:   moveCount & 1 (player 1 always moves first).
 *   - move deadline: the age of the current state UTXO (`this.age`), which
 *             resets automatically on every transition. No field needed.
 */

export const COLS = 7;
export const ROWS = 6;
export const CELLS = COLS * ROWS; // 42

export const EMPTY = 0;
export const P1_DISC = 1;
export const P2_DISC = 2;

/**
 * Default forfeit timeout, in DAA score (block count). Kaspa mainnet runs
 * ~10 blocks/s post-Crescendo, so 36_000 ≈ 1 hour per move. Per-match since
 * timing became state: this is only the creator's default choice.
 */
export const MOVE_TIMEOUT_DAA = 36_000;

/**
 * Contract floor for the per-move timeout (~1 minute): join re-checks it, so
 * a trap genesis with a near-instant forfeit clock is unjoinable.
 */
export const MIN_MOVE_TIMEOUT_DAA = 600;

/**
 * Contract ceiling for the per-move timeout (~10 days): the sequence-lock
 * field would happily encode ~13 years, and a genesis with a decades-long
 * clock turns claim_forfeit into a hostage lock on the joiner's stake — so
 * join makes it unjoinable instead.
 */
export const MAX_MOVE_TIMEOUT_DAA = 8_640_000;

/**
 * Exclusive upper bound for deadlines, mirroring the consensus lock-time
 * threshold: at 500e9 a locktime stops meaning "DAA score" and becomes a
 * unix-ms timestamp, which would let a crafted deadline flip clock semantics
 * (an epoch-ms value is always already in the past). Join keeps every
 * deadline strictly in DAA-score territory.
 */
export const DEADLINE_LIMIT = 500_000_000_000;

/** 32-byte x-only Schnorr pubkey, lowercase hex. */
export type PubKey = string;
export const ZERO_PK: PubKey = "00".repeat(32);

export interface State {
  /**
   * CELLS bytes, column-major: cell (col, row) = board[col * ROWS + row],
   * row 0 = bottom. Column-major so a column is one contiguous 6-byte slice —
   * convenient for the covenant's height check.
   */
  board: Uint8Array;
  moveCount: number;
  p1: PubKey;
  /** ZERO_PK until a second player joins. */
  p2: PubKey;
  /** Per-player stake in sompi. Pot = 2 * stake once joined. */
  stake: bigint;
  /** Per-move forfeit timeout in DAA blocks; chosen at creation. */
  moveTimeout: number;
  /** Absolute DAA score after which the whole game sudden-death splits;
   * 0 = uncapped. Chosen at creation (creation DAA + total duration). */
  deadline: number;
}

export function newMatch(
  p1: PubKey,
  stake: bigint,
  moveTimeout: number,
  deadline: number,
): State {
  if (!isPubKey(p1) || p1 === ZERO_PK) throw new Error("invalid p1 pubkey");
  if (stake <= 0n) throw new Error("stake must be positive");
  if (!Number.isInteger(moveTimeout) || moveTimeout < MIN_MOVE_TIMEOUT_DAA)
    throw new Error("move timeout below minimum");
  if (moveTimeout > MAX_MOVE_TIMEOUT_DAA) throw new Error("move timeout above maximum");
  // A deadline is mandatory: it is the one permissionless exit every match is
  // guaranteed, so a pot can never be stranded by two vanished players. Join
  // re-checks, making an uncapped genesis unjoinable rather than a trap.
  if (!Number.isInteger(deadline) || deadline <= 0 || deadline >= DEADLINE_LIMIT)
    throw new Error("bad deadline");
  return {
    board: new Uint8Array(CELLS),
    moveCount: 0,
    p1,
    p2: ZERO_PK,
    stake,
    moveTimeout,
    deadline,
  };
}

export function isPubKey(pk: string): boolean {
  return /^[0-9a-f]{64}$/.test(pk);
}

export function cellIndex(col: number, row: number): number {
  return col * ROWS + row;
}

/** Number of discs in a column. Discs always stack contiguously from row 0. */
export function heightOf(board: Uint8Array, col: number): number {
  let h = 0;
  while (h < ROWS && board[cellIndex(col, h)] !== EMPTY) h++;
  return h;
}

/** 0 = p1 to move, 1 = p2 to move. */
export function playerToMove(s: State): 0 | 1 {
  return (s.moveCount & 1) as 0 | 1;
}

export function pubkeyOf(s: State, player: 0 | 1): PubKey {
  return player === 0 ? s.p1 : s.p2;
}

export function discOf(player: 0 | 1): number {
  return player === 0 ? P1_DISC : P2_DISC;
}

export function isOpen(s: State): boolean {
  return s.p2 === ZERO_PK;
}

export function pot(s: State): bigint {
  return isOpen(s) ? s.stake : 2n * s.stake;
}

// --- Canonical serialization -------------------------------------------------
//
// Fixed layout, one valid encoding per state — the same guarantee the
// Silverscript compiler gives by splicing fixed-size fields into the redeem
// script. Layout: board[42] | moveCount u8 | p1[32] | p2[32] | stake u64le
//               | moveTimeout u32le | deadline u64le.

export const STATE_BYTES = CELLS + 1 + 32 + 32 + 8 + 4 + 8; // 127

export function encodeState(s: State): Uint8Array {
  const out = new Uint8Array(STATE_BYTES);
  out.set(s.board, 0);
  out[CELLS] = s.moveCount;
  out.set(hexToBytes(s.p1), CELLS + 1);
  out.set(hexToBytes(s.p2), CELLS + 33);
  const view = new DataView(out.buffer);
  view.setBigUint64(CELLS + 65, s.stake, true);
  view.setUint32(CELLS + 73, s.moveTimeout, true);
  view.setBigUint64(CELLS + 77, BigInt(s.deadline), true);
  return out;
}

export function decodeState(buf: Uint8Array): State {
  if (buf.length !== STATE_BYTES) throw new Error("bad state length");
  const board = buf.slice(0, CELLS);
  for (const b of board) {
    if (b !== EMPTY && b !== P1_DISC && b !== P2_DISC) throw new Error("bad cell value");
  }
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    board,
    moveCount: buf[CELLS]!,
    p1: bytesToHex(buf.slice(CELLS + 1, CELLS + 33)),
    p2: bytesToHex(buf.slice(CELLS + 33, CELLS + 65)),
    stake: view.getBigUint64(CELLS + 65, true),
    moveTimeout: view.getUint32(CELLS + 73, true),
    deadline: Number(view.getBigUint64(CELLS + 77, true)),
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
