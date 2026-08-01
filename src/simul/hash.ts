/**
 * The commitment hash. blake2b with a 32-byte digest is what the script
 * engine's OpBlake2b computes (blake2b_simd Params::hash_length(32)), so the
 * covenant can verify a reveal with a single opcode. @noble/hashes is the
 * repo's only runtime dependency — tiny, audited, and environment-pure, so
 * this module works in node and the browser alike.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import { COLS } from "../state.js";
import { type Commitment } from "./state.js";

export const SALT_BYTES = 32;

export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(data).digest();
}

/** The commitment preimage is exactly what the covenant hashes: colByte || salt. */
export function commitmentOf(col: number, salt: Uint8Array): Commitment {
  if (!Number.isInteger(col) || col < 0 || col >= COLS) throw new Error("column out of range");
  if (salt.length !== SALT_BYTES) throw new Error("bad salt length");
  const preimage = new Uint8Array(1 + SALT_BYTES);
  preimage[0] = col;
  preimage.set(salt, 1);
  return Array.from(blake2b256(preimage), (x) => x.toString(16).padStart(2, "0")).join("");
}
