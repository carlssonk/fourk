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

/** Body: legacy section, then readyMask byte, varint pickDeadline,
 * firstCommitter byte, varint revealTimeout. */
export function pushSimul2Section(out: number[], core: SimulCore2): void {
  pushSimulSection(out, core);
  if (core.readyMask < 0 || core.readyMask > 3) throw new Error("bad ready mask in match");
  if (core.firstCommitter < 0 || core.firstCommitter > 2)
    throw new Error("bad first committer in match");
  out.push(core.readyMask);
  pushVarint(out, BigInt(core.pickDeadline));
  out.push(core.firstCommitter);
  pushVarint(out, BigInt(core.revealTimeout));
}

export function takeSimul2Section(buf: Uint8Array, i: { p: number }): SimulCore2 {
  const legacy = takeSimulSection(buf, i);
  const readyMask = takeByte(buf, i);
  if (readyMask > 3) throw new Error("bad ready mask in share code");
  const pickDeadline = Number(readVarint(buf, i));
  const firstCommitter = takeByte(buf, i);
  if (firstCommitter > 2) throw new Error("bad first committer in share code");
  const revealTimeout = Number(readVarint(buf, i));
  if (!Number.isSafeInteger(pickDeadline) || !Number.isSafeInteger(revealTimeout))
    throw new Error("bad V2 timing in share code");
  return { ...legacy, readyMask, pickDeadline, firstCommitter, revealTimeout };
}

export function simul2ToFlatJson(core: SimulCore2): Record<string, unknown> {
  return {
    ...simulToFlatJson(core),
    readyMask: core.readyMask,
    pickDeadline: core.pickDeadline,
    firstCommitter: core.firstCommitter,
    revealTimeout: core.revealTimeout,
  };
}

export function simul2FromFlatJson(
  raw: Parameters<typeof simulFromFlatJson>[0] & {
    readyMask?: number | undefined;
    pickDeadline?: number | undefined;
    firstCommitter?: number | undefined;
    revealTimeout?: number | undefined;
  },
): SimulCore2 {
  if (
    raw.readyMask === undefined ||
    raw.pickDeadline === undefined ||
    raw.firstCommitter === undefined ||
    raw.revealTimeout === undefined
  )
    throw new Error("fourk2 record without its V2 round state");
  return {
    ...simulFromFlatJson(raw),
    readyMask: raw.readyMask,
    pickDeadline: raw.pickDeadline,
    firstCommitter: raw.firstCommitter,
    revealTimeout: raw.revealTimeout,
  };
}
