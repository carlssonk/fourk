/**
 * The committed differential vectors (test/vectors/differential.json) must be
 * exactly what the current rulebooks generate. wasm/tests/differential.rs
 * replays them against the compiled covenant; this test is what ties that
 * replay to today's TS. Regenerate after a rules change with `pnpm vectors`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateVectors, serialize } from "./differential/generate.js";

const PATH = new URL("./vectors/differential.json", import.meta.url);

describe("differential vectors", () => {
  const file = generateVectors();
  const text = serialize(file);

  it("are current", () => {
    if (process.env.UPDATE_VECTORS) writeFileSync(PATH, text);
    expect(readFileSync(PATH, "utf8")).toBe(text);
  });

  it("pose both outcomes for every door", () => {
    // Accepted doors are `door` vectors; refused ones are spent as `shape`s.
    const seen = new Map<string, Set<boolean>>();
    for (const v of file.vectors) {
      if (v.class === "mutant") continue;
      const key = `${file.states[v.input]!.actor}::${v.entry}`;
      seen.set(key, (seen.get(key) ?? new Set()).add(v.accept));
    }
    const oneSided = [...seen].filter(([, outcomes]) => outcomes.size < 2).map(([key]) => key);
    expect(oneSided).toEqual([]);
  });
});
