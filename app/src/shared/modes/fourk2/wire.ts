/**
 * Fourk V2 wire arms: the share-code mode section (mode byte 2) and the flat
 * match.json keys. The section is the legacy fourk section followed by the
 * four V2 fields — all consensus state, since a V2 address derives from them.
 */

import { pushVarint, readVarint, takeByte } from "../../lib/bytes";
import {
  pushSimulSection,
  simulFromFlatJson,
  simulToFlatJson,
  takeSimulSection,
} from "../fourk/wire";
import type { SimulCore2 } from "./core";

export const FOURK2_MODE_BYTE = 2;

/** Body: legacy section, then varint pickDeadline, firstCommitter byte,
 * varint revealTimeout, quick byte. */
export function pushSimul2Section(out: number[], core: SimulCore2): void {
  pushSimulSection(out, core);
  if (core.firstCommitter < 0 || core.firstCommitter > 2)
    throw new Error("bad first committer in match");
  pushVarint(out, BigInt(core.pickDeadline));
  out.push(core.firstCommitter);
  pushVarint(out, BigInt(core.revealTimeout));
  if (core.quick !== 0 && core.quick !== 1) throw new Error("bad quick flag in match");
  out.push(core.quick);
}

export function takeSimul2Section(buf: Uint8Array, i: { p: number }): SimulCore2 {
  const legacy = takeSimulSection(buf, i);
  const pickDeadline = Number(readVarint(buf, i));
  const firstCommitter = takeByte(buf, i);
  if (firstCommitter > 2) throw new Error("bad first committer in share code");
  const revealTimeout = Number(readVarint(buf, i));
  if (!Number.isSafeInteger(pickDeadline) || !Number.isSafeInteger(revealTimeout))
    throw new Error("bad V2 timing in share code");
  const quick = takeByte(buf, i);
  if (quick > 1) throw new Error("bad quick flag in share code");
  return { ...legacy, pickDeadline, firstCommitter, revealTimeout, quick };
}

export function simul2ToFlatJson(core: SimulCore2): Record<string, unknown> {
  return {
    ...simulToFlatJson(core),
    pickDeadline: core.pickDeadline,
    firstCommitter: core.firstCommitter,
    revealTimeout: core.revealTimeout,
    quick: core.quick,
  };
}

export function simul2FromFlatJson(
  raw: Parameters<typeof simulFromFlatJson>[0] & {
    pickDeadline?: number | undefined;
    firstCommitter?: number | undefined;
    revealTimeout?: number | undefined;
    quick?: number | undefined;
  },
): SimulCore2 {
  if (
    raw.pickDeadline === undefined ||
    raw.firstCommitter === undefined ||
    raw.revealTimeout === undefined ||
    raw.quick === undefined
  )
    throw new Error("fourk2 record without its V2 round state");
  return {
    ...simulFromFlatJson(raw),
    pickDeadline: raw.pickDeadline,
    firstCommitter: raw.firstCommitter,
    revealTimeout: raw.revealTimeout,
    quick: raw.quick,
  };
}
