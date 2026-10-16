import { expect, test } from "vitest";
import { createLimiter, limitFromEnv } from "../sweeper/limit";

test("a limit setting is a positive whole number, or the default stands", () => {
  expect(limitFromEnv("1000")).toBe(1000);
  // A typo must never lift the limit: NaN compares false, which never refuses.
  for (const bad of [undefined, "", "abc", "0", "-5", "2.5", "1e3x"])
    expect(limitFromEnv(bad), String(bad)).toBeUndefined();
});

test("a limiter refuses past its count, per client, and resets each window", () => {
  let t = 0;
  const limited = createLimiter(2, () => t);
  expect([limited("a"), limited("a"), limited("a")]).toEqual([false, false, true]);
  expect(limited("b")).toBe(false);
  t += 60_000;
  expect(limited("a")).toBe(false);
});
