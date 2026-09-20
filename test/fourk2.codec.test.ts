/**
 * Fourk V2 on the wire: the share-code mode section (mode byte 2) and the
 * match.json keys carry the shared picking cutoff — consensus state, since
 * a V2 address derives from it — and both decoders hold untrusted input to
 * the V2 reachability invariants.
 */

import { describe, expect, test } from "vitest";
import { decodeMatchBinary, encodeMatchBinary } from "../app/src/shared/lib/sharecode";
import { matchFromJson, matchToJson, type Match } from "../app/src/shared/lib/match";
import { ZERO_PK, type State } from "../app/src/shared/lib/game";
import { zeroCore2, type SimulCore2 } from "../app/src/shared/modes/fourk2/core";
import { ZERO_HASH } from "../app/src/shared/modes/fourk/core";

const P1 = "11".repeat(32);
const P2 = "22".repeat(32);
const COV = "ab".repeat(32);
const TXID = "cd".repeat(32);
const HASH = "ef".repeat(32);

function v2Match(core: Partial<SimulCore2> = {}, state: Partial<State> = {}): Match {
  const s: State = {
    p1: P1,
    p2: P2,
    board: new Uint8Array(42),
    moveCount: 0,
    stake: 100_000_000n,
    moveTimeout: 1200,
    deadline: 900_000,
    ...state,
  };
  return {
    network: "testnet-10",
    covenantId: COV,
    txid: TXID,
    state: s,
    value: s.p2 === ZERO_PK ? s.stake : s.stake * 2n,
    mode: "fourk2",
    simul: { ...zeroCore2(600), ...core },
  };
}

function roundTrips(m: Match): void {
  const viaCode = decodeMatchBinary(encodeMatchBinary(m));
  expect(viaCode.mode).toBe("fourk2");
  expect(viaCode.simul).toEqual(m.simul);
  expect([...viaCode.state.board]).toEqual([...m.state.board]);
  const viaJson = matchFromJson(matchToJson(m));
  expect(viaJson.mode).toBe("fourk2");
  expect(viaJson.simul).toEqual(m.simul);
}

describe("fourk2 wire formats", () => {
  test("every round sub-phase round-trips through both codecs", () => {
    roundTrips(v2Match({}, { p2: ZERO_PK }));
    roundTrips(v2Match());
    // The first round: no cutoff under the lone pick, S1 + T after.
    roundTrips(v2Match({ commit1: HASH, pickDeadline: 0, firstCommitter: 1 }));
    roundTrips(v2Match({ commit1: HASH, commit2: HASH, pickDeadline: 5000, firstCommitter: 2 }));
    const two = new Uint8Array(42);
    two[0] = 1;
    two[6] = 2;
    const later = { board: two, moveCount: 2 };
    roundTrips(v2Match({ round: 1 }, later));
    roundTrips(v2Match({ round: 1, commit1: HASH, pickDeadline: 5000, firstCommitter: 1 }, later));
    roundTrips(
      v2Match(
        { round: 1, commit1: HASH, commit2: HASH, pickDeadline: 5090, firstCommitter: 2 },
        later,
      ),
    );
    roundTrips(v2Match({ round: 1, commit2: HASH, reveal1: 3 }, later));
    const board = new Uint8Array(42);
    board.set([1, 1, 1, 1]);
    roundTrips(v2Match({ round: 4, pendingWin: 1 }, { board, moveCount: 4 }));
  });

  test("the legacy mode byte still decodes as legacy fourk", () => {
    const legacy: Match = { ...v2Match(), mode: "fourk", simul: { ...zeroCore2(600) } };
    delete (legacy.simul as Partial<SimulCore2>).pickDeadline;
    delete (legacy.simul as Partial<SimulCore2>).firstCommitter;
    delete (legacy.simul as Partial<SimulCore2>).revealTimeout;
    const decoded = decodeMatchBinary(encodeMatchBinary(legacy));
    expect(decoded.mode).toBe("fourk");
    expect(decoded.simul).toEqual(legacy.simul);
  });

  test("the observational acceptance stamp is stored, never shared", () => {
    const m = { ...v2Match(), acceptedDaa: 4321 };
    expect(matchFromJson(matchToJson(m)).acceptedDaa).toBe(4321);
    expect(decodeMatchBinary(encodeMatchBinary(m)).acceptedDaa).toBeUndefined();
  });

  test("unreachable V2 states are refused by both decoders", () => {
    const two = new Uint8Array(42);
    two[0] = 1;
    two[6] = 2;
    const later = { board: two, moveCount: 2 };
    const bad: Array<[Partial<SimulCore2>, Partial<State>]> = [
      [{ pickDeadline: 5 }, { p2: ZERO_PK }],
      // A lone first-round pick carries no cutoff; a later one must.
      [{ commit1: HASH, pickDeadline: 5000, firstCommitter: 1 }, {}],
      [{ round: 1, commit1: HASH, pickDeadline: 0, firstCommitter: 1 }, later],
      [{ commit1: HASH, pickDeadline: 0, firstCommitter: 2 }, {}],
      [{ commit1: HASH, pickDeadline: 0, firstCommitter: 0 }, {}],
      [{ commit1: HASH, commit2: HASH, pickDeadline: 1199, firstCommitter: 1 }, {}],
      [{ pickDeadline: 5000 }, {}],
      [{ commit2: HASH, reveal1: 3, pickDeadline: 5000, firstCommitter: 1 }, {}],
      [{ revealTimeout: 599 }, {}],
      [{ revealTimeout: 1201 }, {}],
    ];
    for (const [core, state] of bad) {
      const m = v2Match(core, state);
      expect(() => decodeMatchBinary(encodeMatchBinary(m)), JSON.stringify(core)).toThrow();
      expect(() => matchFromJson(matchToJson(m)), JSON.stringify(core)).toThrow();
    }
    expect(ZERO_HASH).toBe("00".repeat(32));
  });

  test("a fourk2 record that lost its V2 fields is refused", () => {
    const json = JSON.parse(matchToJson(v2Match()));
    delete json.revealTimeout;
    expect(() => matchFromJson(JSON.stringify(json))).toThrow(/V2 round state/);
  });
});
