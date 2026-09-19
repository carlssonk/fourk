/**
 * The wire-format mode registry: pure codec arms only, safe for the byte
 * codecs (match.ts, sharecode.ts) to import — no engine, no registry, no
 * scripts. The classic-is-absent rule lives in the codecs themselves: a
 * classic match writes no mode section and no mode JSON keys, byte-for-byte
 * as before modes existed. Each fourk protocol version has its own mode
 * byte: 1 = legacy simultaneous play, 2 = shared picking deadlines.
 */

import { takeByte } from "../lib/bytes";
import type { SimulCore } from "./fourk/core";
import { FOURK_MODE_BYTE, pushSimulSection, takeSimulSection } from "./fourk/wire";
import { core2Of, type SimulCore2 } from "./fourk2/core";
import { FOURK2_MODE_BYTE, pushSimul2Section, takeSimul2Section } from "./fourk2/wire";

/** The modes that carry a section (everything but classic). */
export type SectionedMode = "fourk" | "fourk2";

/** Write a mode section: mode byte, then the mode's body. */
export function pushModeSection(
  out: number[],
  mode: SectionedMode,
  simul: SimulCore | undefined,
): void {
  if (mode === "fourk2") {
    out.push(FOURK2_MODE_BYTE);
    pushSimul2Section(out, core2Of({ simul }));
    return;
  }
  out.push(FOURK_MODE_BYTE);
  pushSimulSection(out, simul);
}

/** Read a mode section; unknown mode bytes are a hard wall (an old client
 * must refuse a code it cannot address-derive, not misread it). */
export function takeModeSection(
  buf: Uint8Array,
  i: { p: number },
): { mode: "fourk"; simul: SimulCore } | { mode: "fourk2"; simul: SimulCore2 } {
  const modeByte = takeByte(buf, i);
  if (modeByte === FOURK_MODE_BYTE) return { mode: "fourk", simul: takeSimulSection(buf, i) };
  if (modeByte === FOURK2_MODE_BYTE) return { mode: "fourk2", simul: takeSimul2Section(buf, i) };
  throw new Error("unknown game mode in share code");
}
