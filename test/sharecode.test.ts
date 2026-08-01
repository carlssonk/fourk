import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeMatchBinary,
  encodeMatchBinary,
} from "../app/src/shared/lib/sharecode";
import type { Match } from "../app/src/shared/lib/match";
import { CELLS, ZERO_PK, type State } from "../app/src/shared/lib/game";

const P1 = "11".repeat(32);
const P2 = "22".repeat(32);
const COV = "ab".repeat(32);
const TXID = "cd".repeat(32);

function match(state: Partial<State>, value?: bigint): Match {
  const s: State = {
    p1: P1,
    p2: ZERO_PK,
    board: new Uint8Array(CELLS),
    moveCount: 0,
    stake: 100_000_000n,
    moveTimeout: 36_000,
    deadline: 0,
    ...state,
  };
  const derived = s.p2 === ZERO_PK ? s.stake : s.stake * 2n;
  return { network: "testnet-10", covenantId: COV, txid: TXID, state: s, value: value ?? derived };
}

function roundTrip(m: Match): Match {
  return decodeMatchBinary(base64UrlToBytes(bytesToBase64Url(encodeMatchBinary(m))));
}

function expectEqual(a: Match, b: Match) {
  expect(b.mode).toEqual(a.mode);
  expect(b.simul).toEqual(a.simul);
  expect(b.network).toBe(a.network);
  expect(b.covenantId).toBe(a.covenantId);
  expect(b.txid).toBe(a.txid);
  expect(b.value).toBe(a.value);
  expect(b.state.p1).toBe(a.state.p1);
  expect(b.state.p2).toBe(a.state.p2);
  expect(b.state.moveCount).toBe(a.state.moveCount);
  expect(b.state.stake).toBe(a.state.stake);
  expect([...b.state.board]).toEqual([...a.state.board]);
  expect(b.profiles).toEqual(a.profiles);
  expect(b.p1Color).toEqual(a.p1Color);
  expect(b.state.moveTimeout).toBe(a.state.moveTimeout);
  expect(b.state.deadline).toBe(a.state.deadline);
}

describe("binary share codes", () => {
  test("open match round-trips (no p2, derived value)", () => {
    const m = match({});
    expectEqual(m, roundTrip(m));
    // open matches skip p2 entirely
    expect(encodeMatchBinary(m).length).toBeLessThan(120);
  });

  test("mid-game match round-trips", () => {
    const board = new Uint8Array(CELLS);
    board[0] = 1;
    board[6] = 2;
    board[1] = 1;
    const m = match({ p2: P2, board, moveCount: 3 });
    expectEqual(m, roundTrip(m));
  });

  test("full board round-trips", () => {
    const board = Uint8Array.from({ length: CELLS }, (_, i) => 1 + (i % 2));
    const m = match({ p2: P2, board, moveCount: CELLS });
    expectEqual(m, roundTrip(m));
  });

  test("unusual value and moveCount fall back to stored fields", () => {
    const m = match({ p2: P2 }, 123_456_789n); // pot != 2*stake
    m.state = { ...m.state, moveCount: 7 }; // != disc count (0)
    expectEqual(m, roundTrip(m));
  });

  test("random states round-trip (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: CELLS, maxLength: CELLS }),
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        (cells, joined, stake) => {
          const board = Uint8Array.from(cells);
          const m = match({ p2: joined ? P2 : ZERO_PK, board, moveCount: cells.filter((c) => c !== 0).length, stake });
          expectEqual(m, roundTrip(m));
        },
      ),
    );
  });

  test("link-sized: compact codes stay under 200 chars", () => {
    const board = Uint8Array.from({ length: CELLS }, (_, i) => i % 3);
    const m = match({ p2: P2, board, moveCount: board.filter((c) => c !== 0).length });
    const code = bytesToBase64Url(encodeMatchBinary(m));
    expect(code.length).toBeLessThan(200);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no escaping needed
  });

  test.each([
    ["truncated", (b: Uint8Array) => b.slice(0, b.length - 3)],
    ["trailing bytes", (b: Uint8Array) => Uint8Array.from([...b, 0])],
    ["profile bit without a profile section", (b: Uint8Array) => Uint8Array.from([b[0]! | 0x80, ...b.slice(1)])],
    // joined layout: flags(1) + 4 * 32 hashes puts the board-length byte at 129
    ["bad board length", (b: Uint8Array) => Uint8Array.from(b.map((x, i) => (i === 129 ? 99 : x)))],
  ])("corrupt code (%s) throws instead of decoding garbage", (_label, corrupt) => {
    const good = encodeMatchBinary(match({ p2: P2 }));
    expect(() => decodeMatchBinary(corrupt(good))).toThrow();
  });

  test("base64url rejects invalid characters", () => {
    expect(() => base64UrlToBytes("abc$def")).toThrow("bad share-code character");
  });
});

describe("profiles in share codes", () => {
  const alice = { name: "Alice", avatar: "0123456789abcdef" };
  const bob = { name: "Böb 🎲", avatar: "fedcba9876543210" };

  test("open match carries p1's profile", () => {
    const m = { ...match({}), profiles: { p1: alice } };
    expectEqual(m, roundTrip(m));
  });

  test("joined match carries both profiles", () => {
    const m = { ...match({ p2: P2 }), profiles: { p1: alice, p2: bob } };
    expectEqual(m, roundTrip(m));
  });

  test("p2-only profile round-trips (host never named themselves)", () => {
    const m = { ...match({ p2: P2 }), profiles: { p2: bob } };
    expectEqual(m, roundTrip(m));
  });

  test("profile-free matches emit the original v0 format", () => {
    expect(encodeMatchBinary(match({ p2: P2 }))[0]! & 0x80).toBe(0);
  });

  test("p1's colour choice rides the extension section", () => {
    const m = { ...match({}), profiles: { p1: alice }, p1Color: "blue" as const };
    expectEqual(m, roundTrip(m));
  });

  test("colour without profiles still round-trips", () => {
    const m = { ...match({ p2: P2 }), p1Color: "blue" as const };
    expectEqual(m, roundTrip(m));
  });

  test("the default red mapping is never stored", () => {
    // p1Color red decodes as absent — same meaning, canonical form.
    const m = { ...match({}), profiles: { p1: alice }, p1Color: "red" as const };
    expect(roundTrip(m).p1Color).toBeUndefined();
  });

  test("non-default timing rides the extension (it derives the address)", () => {
    const blitz = { ...match({ p2: P2, moveTimeout: 3000, deadline: 12_345_678 }) };
    expectEqual(blitz, roundTrip(blitz));
    const withEverything = {
      ...match({ moveTimeout: 600, deadline: 99 }),
      profiles: { p1: alice },
      p1Color: "blue" as const,
    };
    expectEqual(withEverything, roundTrip(withEverything));
  });

  test("default timing is never stored", () => {
    const m = match({ p2: P2 });
    expect(encodeMatchBinary(m)[0]! & 0x80).toBe(0);
    expectEqual(m, roundTrip(m));
  });

  test("unknown extension flags throw instead of decoding garbage", () => {
    const good = encodeMatchBinary({ ...match({}), profiles: { p1: alice } });
    // The extension flags byte directly follows the v0 payload; bits 5-7 are
    // the remaining reserved escape hatch (bit 4 became the mode section).
    const pfIndex = encodeMatchBinary(match({})).length;
    const bad = Uint8Array.from(good.map((x, i) => (i === pfIndex ? x | 0x20 : x)));
    expect(() => decodeMatchBinary(bad)).toThrow("unknown share-code format version");
  });
});

describe("fourk mode in share codes", () => {
  const ZERO_HASH = "00".repeat(32);
  const H1 = "a1".repeat(32);
  const H2 = "b2".repeat(32);
  const zeroCore = { round: 0, commit1: ZERO_HASH, commit2: ZERO_HASH, reveal1: 0, reveal2: 0 };

  test("an open fourk lobby round-trips with its mode", () => {
    const m: Match = { ...match({}), mode: "fourk", simul: zeroCore };
    expectEqual(m, roundTrip(m));
  });

  test("between rounds: mode + round number, no slots", () => {
    const board = new Uint8Array(CELLS);
    board[0] = 1;
    board[6] = 2;
    const m: Match = {
      ...match({ p2: P2, board, moveCount: 2 }),
      mode: "fourk",
      simul: { ...zeroCore, round: 1 },
    };
    expectEqual(m, roundTrip(m));
  });

  test("mid-round slots travel: commitments and a reveal", () => {
    const bothCommitted: Match = {
      ...match({ p2: P2 }),
      mode: "fourk",
      simul: { ...zeroCore, commit1: H1, commit2: H2 },
    };
    expectEqual(bothCommitted, roundTrip(bothCommitted));

    // After the first reveal: the revealer's commitment is zeroed.
    const halfRevealed: Match = {
      ...match({ p2: P2 }),
      mode: "fourk",
      simul: { ...zeroCore, round: 3, commit2: H2, reveal1: 4 },
    };
    expectEqual(halfRevealed, roundTrip(halfRevealed));
  });

  test("mode composes with profiles, colour, and timing", () => {
    const m: Match = {
      ...match({ p2: P2, moveTimeout: 3000, deadline: 12_345 }),
      mode: "fourk",
      simul: { ...zeroCore, commit1: H1 },
      profiles: { p1: { name: "Alice", avatar: "0123456789abcdef" } },
      p1Color: "blue" as const,
    };
    expectEqual(m, roundTrip(m));
  });

  test("classic codes are byte-identical to before the mode existed", () => {
    // No extension at all for a default classic match.
    expect(encodeMatchBinary(match({ p2: P2 }))[0]! & 0x80).toBe(0);
  });

  test("an open lobby claiming round state is rejected", () => {
    const m: Match = {
      ...match({}),
      mode: "fourk",
      simul: { ...zeroCore, commit1: H1 },
    };
    expect(() => roundTrip(m)).toThrow("open match with round state");
  });

  test("both reveals set is rejected (unrepresentable in a stored state)", () => {
    const m: Match = {
      ...match({ p2: P2 }),
      mode: "fourk",
      simul: { ...zeroCore, reveal1: 3, reveal2: 5 },
    };
    expect(() => roundTrip(m)).toThrow("bad reveal");
  });

  test("unknown mode byte and slot-mask bits are rejected", () => {
    const good = encodeMatchBinary({ ...match({ p2: P2 }), mode: "fourk", simul: zeroCore });
    // Mode section trails the code: [modeByte, roundVarint(0), slotMask(0)].
    const modeAt = good.length - 3;
    const badMode = Uint8Array.from(good.map((x, i) => (i === modeAt ? 2 : x)));
    expect(() => decodeMatchBinary(badMode)).toThrow("unknown game mode");
    const badMask = Uint8Array.from(good.map((x, i) => (i === good.length - 1 ? 0x40 : x)));
    expect(() => decodeMatchBinary(badMask)).toThrow("bad slot mask");
  });
});

describe("share-code hardening", () => {
  test("byte-capped names trim whole code points, never mid-surrogate", () => {
    // 5 ascii + 7 emoji = 33 utf8 bytes: one over the 32-byte wire cap, and
    // trimming one UTF-16 unit would leave a lone surrogate (encoded U+FFFD).
    const name = "aaaaa" + "😀".repeat(7);
    const m = { ...match({}), profiles: { p1: { name, avatar: "0123456789abcdef" } } };
    const decoded = roundTrip(m).profiles!.p1!.name;
    expect(decoded).toBe("aaaaa" + "😀".repeat(6));
    expect(decoded).not.toContain("�");
  });

  test("absurd moveCount is rejected", () => {
    const m = match({ p2: P2 });
    m.state = { ...m.state, moveCount: CELLS + 8 }; // stored, since != disc count
    expect(() => roundTrip(m)).toThrow("bad move count");
  });

  test("zero move timeout is rejected", () => {
    const m = match({ p2: P2, moveTimeout: 0 }); // forces the timing extension
    expect(() => roundTrip(m)).toThrow("zero move timeout");
  });

  test("joined flag with an all-zero p2 is rejected", () => {
    const good = encodeMatchBinary(match({ p2: P2 }));
    // joined layout: flags(1) + covenantId(32) + txid(32) + p1(32), then p2.
    const bad = Uint8Array.from(good.map((x, i) => (i >= 97 && i < 129 ? 0 : x)));
    expect(() => decodeMatchBinary(bad)).toThrow("zero p2");
  });
});
