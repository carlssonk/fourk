import { expect, test } from "vitest";
import { fmtCountdown } from "../src/shared/lib/match";

test.each([
  [86400, "24:00:00"],
  [85320, "23:42:00"],
  [3600, "01:00:00"],
  [60, "00:01:00"],
  [59, "00:00:59"],
  [0.1, "00:00:01"],
  [0, "00:00:00"],
  [-10, "00:00:00"],
  [NaN, "00:00:00"],
  [Infinity, "00:00:00"],
  [360000, "100:00:00"],
])("countdown formats %s seconds as %s", (seconds, expected) => {
  expect(fmtCountdown(seconds)).toBe(expected);
});
