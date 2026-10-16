import { expect, test } from "vitest";
import {
  QUICK_MATCH_MOVE_TIMEOUT,
  QUICK_MATCH_TOTAL_CAP,
  isQuickMatchTerms,
} from "../src/shared/lib/quickMatch";
import { timingFor } from "../src/shared/state/profile";
import { ZERO_PK } from "../src/shared/lib/game";
import { FREE_STAKE, NETWORK_ID, type Match } from "../src/shared/lib/match";
import { zeroCore2 } from "../src/shared/modes/fourk2/core";
import { modeOf } from "../src/shared/modes/registry";

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

// The same, in Classic: no round machine, so no Quick Match flag either.
const classicLobby: Match = { ...lobby, mode: undefined, simul: undefined };

test("a free Fourk lobby on the 2-minute clock is a Fourk Quick Match", () => {
  expect(isQuickMatchTerms(lobby, "fourk2")).toBe(true);
  expect(isQuickMatchTerms(lobby, "classic")).toBe(false);
});

test("a free Classic lobby on the 2-minute clock is a Classic Quick Match", () => {
  expect(isQuickMatchTerms(classicLobby, "classic")).toBe(true);
  expect(isQuickMatchTerms(classicLobby, "fourk2")).toBe(false);
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
  for (const [why, m] of off) expect(isQuickMatchTerms(m, "fourk2"), why).toBe(false);
});

test("refuses a Classic lobby off the terms", () => {
  const off: [string, Match][] = [
    ["staked", { ...classicLobby, state: { ...classicLobby.state, stake: 100_000_000n } }],
    ["another clock", { ...classicLobby, state: { ...classicLobby.state, moveTimeout: 3_000 } }],
    ["seat taken", { ...classicLobby, state: { ...classicLobby.state, p2: "22".repeat(32) } }],
  ];
  for (const [why, m] of off) expect(isQuickMatchTerms(m, "classic"), why).toBe(false);
});

test("a game knows Quick Match paired it: from the covenant in Fourk, our own mark in Classic", () => {
  const joined = (m: Match): Match => ({ ...m, state: { ...m.state, p2: "22".repeat(32) } });
  // Fourk's flag is chain state: it holds on another device, with no mark.
  expect(modeOf(lobby).isQuickMatched(joined(lobby))).toBe(true);
  const invite = { ...lobby, simul: zeroCore2(1_200) };
  expect(modeOf(invite).isQuickMatched(joined(invite))).toBe(false);
  expect(modeOf(invite).isQuickMatched({ ...joined(invite), paired: true })).toBe(true);
  // Classic has only the mark.
  expect(modeOf(classicLobby).isQuickMatched(joined(classicLobby))).toBe(false);
  expect(modeOf(classicLobby).isQuickMatched({ ...joined(classicLobby), paired: true })).toBe(true);
});

test("the preset cap is what a hosted game gets at the Quick Match clock", () => {
  expect(timingFor(QUICK_MATCH_MOVE_TIMEOUT).totalCap).toBe(QUICK_MATCH_TOTAL_CAP);
});
