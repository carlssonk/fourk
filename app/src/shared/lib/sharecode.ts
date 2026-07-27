/**
 * Compact binary share codes for invite links (~190 chars vs ~460 for the
 * old base64-JSON).
 *
 * Layout (all integers little-endian LEB128 varints):
 *   flags        1 byte: bits0-3 network index | bit4 p2 joined
 *                | bit5 value stored | bit6 moveCount stored | bit7 extension
 *                (bit7 marks the v1 extension section appended after
 *                moveCount: its own flags byte — bit0 p1 profile, bit1 p2
 *                profile, bit2 p1 plays blue, bit3 timing stored (varint
 *                moveTimeout + varint deadline; absent = the defaults) —
 *                keeps bits 4-7 free as the next escape hatch. Timing is
 *                consensus state: the game address derives from it, so a
 *                non-default clock MUST travel in the code.)
 *   covenantId   32 bytes
 *   txid         32 bytes
 *   p1           32 bytes
 *   p2           32 bytes, only if joined (open matches derive the zero key)
 *   board        1-byte cell count, then cells packed 5 trits/byte (3^5 < 256)
 *   stake        varint sompi
 *   value        varint, only if it differs from the derived stake/2*stake
 *   moveCount    varint, only if it differs from the non-zero cell count
 *
 * The derivations are covenant-enforced invariants (join doubles the pot
 * exactly, moves preserve it, discs are never removed), so the stored
 * fallbacks are safety nets that cost nothing today.
 *
 * NETWORKS is positional in the flags byte: append only, never reorder.
 *
 * This module is environment-pure (no DOM/Node globals) so it can be tested
 * and typechecked anywhere.
 */

import { CELLS, MOVE_TIMEOUT_DAA, ZERO_PK, type State } from "./game";
import { trimName, type Match, type PlayerProfile } from "./match";

const NETWORKS = ["mainnet", "testnet-10", "testnet-11", "devnet", "simnet"];

export function encodeMatchBinary(m: Match): Uint8Array {
  const s = m.state;
  const out: number[] = [];

  const network = NETWORKS.indexOf(m.network);
  if (network < 0) throw new Error(`unknown network ${m.network}`);
  const p2Joined = s.p2 !== ZERO_PK;
  const derivedValue = p2Joined ? s.stake * 2n : s.stake;
  const valueStored = m.value !== derivedValue;
  const derivedMoves = countDiscs(s.board);
  const moveStored = s.moveCount !== derivedMoves;

  const p1Prof = m.profiles?.p1;
  const p2Prof = p2Joined ? m.profiles?.p2 : undefined;
  const p1Blue = m.p1Color === "blue";
  const timingStored = s.moveTimeout !== MOVE_TIMEOUT_DAA || s.deadline !== 0;
  const hasExtension = !!(p1Prof || p2Prof) || p1Blue || timingStored;

  let flags = network;
  if (p2Joined) flags |= 0x10;
  if (valueStored) flags |= 0x20;
  if (moveStored) flags |= 0x40;
  if (hasExtension) flags |= 0x80;
  out.push(flags);

  pushHex32(out, m.covenantId, "covenantId");
  pushHex32(out, m.txid, "txid");
  pushHex32(out, s.p1, "p1");
  if (p2Joined) pushHex32(out, s.p2, "p2");

  out.push(s.board.length);
  for (let i = 0; i < s.board.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; j++) {
      const cell = i + j < s.board.length ? s.board[i + j]! : 0;
      if (cell > 2) throw new Error(`board cell out of range: ${cell}`);
      v = v * 3 + cell;
    }
    out.push(v);
  }

  pushVarint(out, s.stake);
  if (valueStored) pushVarint(out, m.value);
  if (moveStored) pushVarint(out, BigInt(s.moveCount));
  if (hasExtension) {
    out.push((p1Prof ? 1 : 0) | (p2Prof ? 2 : 0) | (p1Blue ? 4 : 0) | (timingStored ? 8 : 0));
    if (p1Prof) pushProfile(out, p1Prof);
    if (p2Prof) pushProfile(out, p2Prof);
    if (timingStored) {
      pushVarint(out, BigInt(s.moveTimeout));
      pushVarint(out, BigInt(s.deadline));
    }
  }
  return Uint8Array.from(out);
}

export function decodeMatchBinary(buf: Uint8Array): Match {
  const i = { p: 0 };
  const flags = takeByte(buf, i);
  const network = NETWORKS[flags & 0x0f];
  if (!network) throw new Error("unknown network in share code");
  const p2Joined = !!(flags & 0x10);
  const valueStored = !!(flags & 0x20);
  const moveStored = !!(flags & 0x40);

  const covenantId = takeHex32(buf, i);
  const txid = takeHex32(buf, i);
  const p1 = takeHex32(buf, i);
  const p2 = p2Joined ? takeHex32(buf, i) : ZERO_PK;

  const cells = takeByte(buf, i);
  if (cells !== CELLS) throw new Error(`bad board length ${cells}`);
  const board = new Uint8Array(cells);
  for (let c = 0; c < cells; c += 5) {
    let v = takeByte(buf, i);
    const trits = [0, 0, 0, 0, 0];
    for (let j = 4; j >= 0; j--) {
      trits[j] = v % 3;
      v = (v - trits[j]!) / 3;
    }
    for (let j = 0; j < 5 && c + j < cells; j++) board[c + j] = trits[j]!;
  }

  const stake = readVarint(buf, i);
  const value = valueStored ? readVarint(buf, i) : p2Joined ? stake * 2n : stake;
  const moveCount = moveStored ? takeSmallInt(buf, i, CELLS, "move count") : countDiscs(board);

  let profiles: Match["profiles"];
  let p1Blue = false;
  let moveTimeout = MOVE_TIMEOUT_DAA;
  let deadline = 0;
  if (flags & 0x80) {
    const pf = takeByte(buf, i);
    if (pf & 0xf0) throw new Error("unknown share-code format version");
    p1Blue = !!(pf & 4);
    if (pf & 3) {
      profiles = {};
      if (pf & 1) profiles.p1 = takeProfile(buf, i);
      if (pf & 2) profiles.p2 = takeProfile(buf, i);
    }
    if (pf & 8) {
      moveTimeout = takeSmallInt(buf, i, Number.MAX_SAFE_INTEGER, "move timeout");
      deadline = takeSmallInt(buf, i, Number.MAX_SAFE_INTEGER, "deadline");
      if (moveTimeout === 0) throw new Error("zero move timeout in share code");
    }
  }
  if (i.p !== buf.length) throw new Error("trailing bytes in share code");

  // Share codes are untrusted input (links pasted by strangers) — hold them
  // to the same invariants the JSON schema enforces on the legacy path.
  if (p2Joined && p2 === ZERO_PK) throw new Error("joined match with zero p2 in share code");

  const state: State = { board, moveCount, p1, p2, stake, moveTimeout, deadline };
  return {
    network,
    covenantId,
    txid,
    value,
    state,
    ...(profiles && { profiles }),
    ...(p1Blue && { p1Color: "blue" as const }),
  };
}

// --- Profiles ----------------------------------------------------------------
//
// Wire form (shared with the join transaction's payload, see covenant.ts):
//   name    1-byte utf8 length (<= 32), then the bytes
//   avatar  8 bytes (the 16-hex gene code)

const MAX_NAME_BYTES = 32;

export function encodeProfileBytes(p: PlayerProfile): Uint8Array {
  const out: number[] = [];
  pushProfile(out, p);
  return Uint8Array.from(out);
}

export function decodeProfileBytes(buf: Uint8Array, i: { p: number }): PlayerProfile {
  return takeProfile(buf, i);
}

function pushProfile(out: number[], p: PlayerProfile): void {
  // Trim by code point, never mid-surrogate-pair: a split pair would encode
  // as U+FFFD and the opponent would see the name end in "�".
  const chars = [...trimName(p.name)];
  let bytes = new TextEncoder().encode(chars.join(""));
  while (bytes.length > MAX_NAME_BYTES) {
    chars.pop();
    bytes = new TextEncoder().encode(chars.join(""));
  }
  out.push(bytes.length, ...bytes);
  if (!/^[0-9a-f]{16}$/.test(p.avatar)) throw new Error("bad avatar code in profile");
  for (let k = 0; k < 16; k += 2) out.push(parseInt(p.avatar.slice(k, k + 2), 16));
}

function takeProfile(buf: Uint8Array, i: { p: number }): PlayerProfile {
  const len = takeByte(buf, i);
  if (len > MAX_NAME_BYTES) throw new Error("profile name too long");
  if (i.p + len + 8 > buf.length) throw new Error("truncated profile");
  const name = trimName(new TextDecoder().decode(buf.slice(i.p, i.p + len)));
  i.p += len;
  let avatar = "";
  for (let k = 0; k < 8; k++) avatar += buf[i.p + k]!.toString(16).padStart(2, "0");
  i.p += 8;
  return { name, avatar };
}

// --- primitives --------------------------------------------------------------

function countDiscs(board: Uint8Array): number {
  return board.reduce((n, c) => n + (c !== 0 ? 1 : 0), 0);
}

function pushHex32(out: number[], hex: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad ${label} in match`);
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
}

function takeHex32(buf: Uint8Array, i: { p: number }): string {
  if (i.p + 32 > buf.length) throw new Error("truncated share code");
  let hex = "";
  for (let k = 0; k < 32; k++) hex += buf[i.p + k]!.toString(16).padStart(2, "0");
  i.p += 32;
  return hex;
}

function takeByte(buf: Uint8Array, i: { p: number }): number {
  if (i.p >= buf.length) throw new Error("truncated share code");
  return buf[i.p++]!;
}

/** Read a varint that must fit a plain number and stay within `max`. */
function takeSmallInt(buf: Uint8Array, i: { p: number }, max: number, label: string): number {
  const v = readVarint(buf, i);
  if (v > BigInt(max)) throw new Error(`bad ${label} in share code`);
  return Number(v);
}

function pushVarint(out: number[], val: bigint): void {
  if (val < 0n) throw new Error("negative varint");
  let v = val;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function readVarint(buf: Uint8Array, i: { p: number }): bigint {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    const b = takeByte(buf, i);
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
}

// --- base64url (environment-pure: no btoa/atob) ------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_REV = new Map([...B64].map((c, i) => [c, i]));

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) out += B64[((b & 15) << 2) | (c >> 6)]!;
    if (i + 2 < bytes.length) out += B64[c & 63]!;
  }
  return out;
}

export function base64UrlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64_REV.get(ch);
    if (v === undefined) throw new Error("bad share-code character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
