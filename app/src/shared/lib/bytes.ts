/**
 * Byte-stream primitives shared by the wire codecs (sharecode.ts and the
 * per-mode wire modules). Environment-pure — no DOM/Node globals.
 */

export function pushHex32(out: number[], hex: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad ${label} in match`);
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
}

export function takeHex32(buf: Uint8Array, i: { p: number }): string {
  if (i.p + 32 > buf.length) throw new Error("truncated share code");
  let hex = "";
  for (let k = 0; k < 32; k++) hex += buf[i.p + k]!.toString(16).padStart(2, "0");
  i.p += 32;
  return hex;
}

export function takeByte(buf: Uint8Array, i: { p: number }): number {
  if (i.p >= buf.length) throw new Error("truncated share code");
  return buf[i.p++]!;
}

/** Read a varint that must fit a plain number and stay within `max`. */
export function takeSmallInt(
  buf: Uint8Array,
  i: { p: number },
  max: number,
  label: string,
): number {
  const v = readVarint(buf, i);
  if (v > BigInt(max)) throw new Error(`bad ${label} in share code`);
  return Number(v);
}

export function pushVarint(out: number[], val: bigint): void {
  if (val < 0n) throw new Error("negative varint");
  let v = val;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

export function readVarint(buf: Uint8Array, i: { p: number }): bigint {
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
