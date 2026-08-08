/**
 * Fourk mode's wire arms: the share-code mode section (see sharecode.ts for
 * the enclosing layout — this is everything after the extension flag's mode
 * bit) and the flat JSON fields the CLI-compatible match.json carries.
 * Consensus state throughout: a fourk match's address derives from the round
 * machine, so a code or record that dropped it would resolve to the wrong
 * covenant address.
 */

import { pushHex32, pushVarint, takeByte, takeHex32, takeSmallInt } from "../../lib/bytes";
import { ZERO_CORE, ZERO_HASH, type SimulCore } from "./core";

export const FOURK_MODE_BYTE = 1;

/** Share-code section body: varint round, a slot bitmask (bit0/1 commitment
 * 1/2 present, bit2/3 reveal 1/2 present, bit4/5 the pendingWin value),
 * then each present commitment (32 bytes) and each present reveal (1 byte,
 * column + 1). Zero slots are omitted — the common between-rounds case
 * costs 3 bytes. */
export function pushSimulSection(out: number[], core: SimulCore | undefined): void {
  const c = core ?? ZERO_CORE;
  pushVarint(out, BigInt(c.round));
  const c1 = c.commit1 !== ZERO_HASH;
  const c2 = c.commit2 !== ZERO_HASH;
  if (c.pendingWin < 0 || c.pendingWin > 2) throw new Error("bad pending win in match");
  out.push(
    (c1 ? 1 : 0) | (c2 ? 2 : 0) | (c.reveal1 ? 4 : 0) | (c.reveal2 ? 8 : 0) | (c.pendingWin << 4),
  );
  if (c1) pushHex32(out, c.commit1, "commit1");
  if (c2) pushHex32(out, c.commit2, "commit2");
  if (c.reveal1) out.push(c.reveal1);
  if (c.reveal2) out.push(c.reveal2);
}

export function takeSimulSection(buf: Uint8Array, i: { p: number }): SimulCore {
  const round = takeSmallInt(buf, i, 255, "round");
  const slots = takeByte(buf, i);
  if (slots & 0xc0) throw new Error("bad slot mask in share code");
  const pendingWin = (slots >> 4) & 3;
  if (pendingWin > 2) throw new Error("bad pending win in share code");
  const commit1 = slots & 1 ? takeHex32(buf, i) : ZERO_HASH;
  const commit2 = slots & 2 ? takeHex32(buf, i) : ZERO_HASH;
  const reveal1 = slots & 4 ? takeByte(buf, i) : 0;
  const reveal2 = slots & 8 ? takeByte(buf, i) : 0;
  if (reveal1 > 7 || reveal2 > 7 || (reveal1 !== 0 && reveal2 !== 0))
    throw new Error("bad reveal in share code");
  if ((slots & 1 && commit1 === ZERO_HASH) || (slots & 2 && commit2 === ZERO_HASH))
    throw new Error("zero commitment in share code");
  // A pending win zeroes the round slots (claimWin's canonical successor);
  // a code carrying both describes a state that cannot exist on-chain.
  if (pendingWin !== 0 && (slots & 0x0f) !== 0)
    throw new Error("pending win with round slots in share code");
  return { round, commit1, commit2, reveal1, reveal2, pendingWin };
}

/** The flat sibling keys the match.json schema carries for a fourk match. */
export function simulToFlatJson(core: SimulCore | undefined): Record<string, unknown> {
  return {
    round: core?.round ?? 0,
    commit1: core?.commit1 ?? ZERO_HASH,
    commit2: core?.commit2 ?? ZERO_HASH,
    reveal1: core?.reveal1 ?? 0,
    reveal2: core?.reveal2 ?? 0,
    pendingWin: core?.pendingWin ?? 0,
  };
}

export function simulFromFlatJson(raw: {
  round?: number | undefined;
  commit1?: string | undefined;
  commit2?: string | undefined;
  reveal1?: number | undefined;
  reveal2?: number | undefined;
  pendingWin?: number | undefined;
}): SimulCore {
  return {
    round: raw.round ?? 0,
    commit1: raw.commit1 ?? ZERO_HASH,
    commit2: raw.commit2 ?? ZERO_HASH,
    reveal1: raw.reveal1 ?? 0,
    reveal2: raw.reveal2 ?? 0,
    pendingWin: raw.pendingWin ?? 0,
  };
}
