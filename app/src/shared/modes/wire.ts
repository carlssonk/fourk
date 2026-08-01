/**
 * The wire-format mode registry: pure codec arms only, safe for the byte
 * codecs (match.ts, sharecode.ts) to import — no engine, no registry, no
 * scripts. The classic-is-absent rule lives in the codecs themselves: a
 * classic match writes no mode section and no mode JSON keys, byte-for-byte
 * as before modes existed. A third mode adds its byte + section here.
 */

import { takeByte } from "../lib/bytes";
import type { SimulCore } from "./fourk/core";
import { FOURK_MODE_BYTE, pushSimulSection, takeSimulSection } from "./fourk/wire";

/** Write a mode section: mode byte, then the mode's body. */
export function pushModeSection(
  out: number[],
  mode: "fourk",
  simul: SimulCore | undefined,
): void {
  out.push(FOURK_MODE_BYTE);
  pushSimulSection(out, simul);
}

/** Read a mode section; unknown mode bytes are a hard wall (an old client
 * must refuse a code it cannot address-derive, not misread it). */
export function takeModeSection(
  buf: Uint8Array,
  i: { p: number },
): { mode: "fourk"; simul: SimulCore } {
  const modeByte = takeByte(buf, i);
  if (modeByte !== FOURK_MODE_BYTE) throw new Error("unknown game mode in share code");
  return { mode: "fourk", simul: takeSimulSection(buf, i) };
}
