import { beforeEach, expect, test, vi } from "vitest";
import {
  finishedLongAgo,
  fmtKasExact,
  loadCheckpoint,
  loadMatches,
  matchToJson,
  parseKas,
  saveMatches,
  type Match,
} from "../src/shared/lib/match";
import { loadSalt, pruneSalts } from "../src/shared/modes/fourk/saltStore";

const bag = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => bag.get(key) ?? null,
  setItem: (key: string, value: string) => void bag.set(key, value),
});
const match: Match = {
  network: "testnet-10",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: 100_000_001n,
  state: {
    p1: "11".repeat(32),
    p2: "00".repeat(32),
    board: new Uint8Array(42),
    moveCount: 0,
    stake: 100_000_001n,
    moveTimeout: 600,
    deadline: 1_000_000,
  },
};
beforeEach(() => bag.clear());

test("editable Max amounts preserve every sompi, including small balances", () => {
  for (const amount of [1n, 9999n, 123456789n, 5_000_000_001n]) {
    expect(parseKas(fmtKasExact(amount))).toBe(amount);
  }
});

test("one corrupt match does not hide valid saved games after it", () => {
  bag.set("fourk.matches", JSON.stringify(["corrupt", matchToJson(match)]));
  expect(loadMatches()).toHaveLength(1);
});

test("null bookkeeping cannot crash loading or saving a game", () => {
  for (const key of ["fourk.finished", "fourk.checkpoints", "fourk.salts"]) bag.set(key, "null");
  expect(loadCheckpoint(match.covenantId)).toBeNull();
  expect(loadSalt(match.covenantId, 0)).toBeNull();
  expect(() => saveMatches([match])).not.toThrow();
  expect(() => pruneSalts([match.covenantId])).not.toThrow();
  expect(finishedLongAgo(match.covenantId)).toBe(false);
});

test("a stored secret with an impossible column is treated as missing", () => {
  bag.set(
    "fourk.salts",
    JSON.stringify({ [`${match.covenantId}:0`]: { col: 7, salt: "aa".repeat(32) } }),
  );
  expect(loadSalt(match.covenantId, 0)).toBeNull();
});
