import { expect, test } from "vitest";
import { isQuickMatchTerms } from "../src/shared/lib/quickMatch";
import { ZERO_PK } from "../src/shared/lib/game";
import { FREE_STAKE, NETWORK_ID, type Match } from "../src/shared/lib/match";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";

// A freshly opened Quick Match lobby, written out by hand from ADR 0003:
// Fourk, free, 1,200 DAA per pick, nobody in the second seat yet.
const lobby: Match = {
  network: NETWORK_ID,
  mode: "fourk2",
  covenantId: "ab".repeat(32),
  txid: "cd".repeat(32),
  value: FREE_STAKE,
  state: {
    p1: "11".repeat(32),
    p2: ZERO_PK,
    board: new Uint8Array(42),
    moveCount: 0,
    stake: FREE_STAKE,
    moveTimeout: 1_200,
    deadline: 900_000,
  },
  simul: zeroCore2(1_200, 1),
};

test("a free Fourk lobby on the 2-minute clock is a Quick Match", () => {
  expect(isQuickMatchTerms(lobby)).toBe(true);
});

test("refuses a lobby that differs from the terms in any way", () => {
  const off: [string, Match][] = [
    ["another network", { ...lobby, network: "mainnet" }],
    ["classic", { ...lobby, mode: undefined, simul: undefined }],
    ["staked", { ...lobby, value: 100_000_000n, state: { ...lobby.state, stake: 100_000_000n } }],
    ["another clock", { ...lobby, state: { ...lobby.state, moveTimeout: 600 } }],
    ["a shorter reveal window", { ...lobby, simul: zeroCore2(600, 1) }],
    ["an invite lobby", { ...lobby, simul: zeroCore2(1_200) }],
    [
      "seat taken",
      { ...lobby, value: FREE_STAKE * 2n, state: { ...lobby.state, p2: "22".repeat(32) } },
    ],
  ];
  for (const [why, m] of off) expect(isQuickMatchTerms(m), why).toBe(false);
});
