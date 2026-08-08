import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeMatchBinary,
  encodeMatchBinary,
} from "../app/src/shared/lib/sharecode";
import { FREE_STAKE, isStaked, type Match } from "../app/src/shared/lib/match";
import {
  CELLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  ZERO_PK,
  applyMove,
  legalColumns,
  type State,
} from "../app/src/shared/lib/game";
import { game as joinedGame } from "./helpers";

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

  test("a value diverging from the stake is rejected — it is what the join debits", () => {
    // A forged invite could otherwise show one price (stake) and spend
    // another (value). Both derivations are covenant-enforced invariants,
    // so divergence describes a match that cannot exist on-chain.
    const m = match({ p2: P2 }, 123_456_789n); // pot != 2*stake
    expect(() => roundTrip(m)).toThrow("value does not match the stake");
  });

  test("a moveCount diverging from the disc count is rejected", () => {
    const m = match({ p2: P2 });
    m.state = { ...m.state, moveCount: 7 }; // != disc count (0)
    expect(() => roundTrip(m)).toThrow("move count does not match the board");
  });

  test("every state the rulebook itself can reach round-trips (property)", () => {
    // The generator IS the rulebook: legal moves from a joined genesis, so
    // the codec is pinned to exactly the states that can exist on-chain —
    // unreachable boards (floating discs, miscounted moves) are rejected by
    // validateReachableState instead of round-tripping.
    fc.assert(
      fc.property(
        fc.array(fc.nat(6), { maxLength: CELLS }),
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        (seeds, open, stake) => {
          let s = joinedGame();
          if (!open)
            for (const seed of seeds) {
              const cols = legalColumns(s);
              if (!cols.length) break;
              s = applyMove(s, cols[seed % cols.length]!);
            }
          const m = open ? match({ stake }) : match({ ...s, stake });
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
    for (const bit of [0x20, 0x40, 0x80]) {
      const bad = Uint8Array.from(good.map((x, i) => (i === pfIndex ? x | bit : x)));
      expect(() => decodeMatchBinary(bad)).toThrow("unknown share-code format version");
    }
  });
});

describe("stakes in share codes", () => {
  test("the stake is the only thing that says whether a game is staked", () => {
    // Nothing in the code marks a game staked: a link is written by whoever
    // sends it, and believing a flag in one is what would let a forged
    // "this game is free" invite spend dispenser funds on a real wager.
    const staked = match({ stake: 25n * 100_000_000n });
    expect(isStaked(roundTrip(staked))).toBe(true);
    expect(roundTrip(staked).state.stake).toBe(staked.state.stake);

    const free = match({ stake: FREE_STAKE });
    expect(isStaked(roundTrip(free))).toBe(false);
  });

  test("a staked game needs no extension section of its own", () => {
    expect(encodeMatchBinary(match({ p2: P2, stake: 25n * 100_000_000n }))[0]! & 0x80).toBe(0);
  });
});

describe("fourk mode in share codes", () => {
  const ZERO_HASH = "00".repeat(32);
  const H1 = "a1".repeat(32);
  const H2 = "b2".repeat(32);
  const zeroCore = {
    round: 0,
    commit1: ZERO_HASH,
    commit2: ZERO_HASH,
    reveal1: 0,
    reveal2: 0,
    pendingWin: 0,
  };

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

  test("a pending win travels — and never alongside round slots", () => {
    const board = new Uint8Array(CELLS);
    for (let c = 0; c < 4; c++) {
      board[c * 6] = 1; // p1's bottom-row line
      if (c < 3) board[c * 6 + 1] = 2;
    }
    const pending: Match = {
      ...match({ p2: P2, board, moveCount: 7 }),
      mode: "fourk",
      simul: { ...zeroCore, round: 4, pendingWin: 1 },
    };
    expectEqual(pending, roundTrip(pending));

    // claimWin zeroes the slots; a code carrying both describes a state
    // that cannot exist on-chain.
    const contradictory: Match = {
      ...match({ p2: P2, board, moveCount: 7 }),
      mode: "fourk",
      simul: { ...zeroCore, round: 4, pendingWin: 2, commit1: H1 },
    };
    expect(() => roundTrip(contradictory)).toThrow("pending win with round slots");
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

  test("out-of-range timing is rejected: trap clock, hostage clock, clock-flipping deadline", () => {
    // The covenant's join gates, applied at the decoder.
    const zero = match({ p2: P2, moveTimeout: 0 }); // forces the timing extension
    expect(() => roundTrip(zero)).toThrow("move timeout below minimum");
    const trap = match({ p2: P2, moveTimeout: MIN_MOVE_TIMEOUT_DAA - 1 });
    expect(() => roundTrip(trap)).toThrow("move timeout below minimum");
    const hostage = match({ p2: P2, moveTimeout: MAX_MOVE_TIMEOUT_DAA + 1 });
    expect(() => roundTrip(hostage)).toThrow("bad move timeout");
    const flipped = match({ p2: P2, deadline: DEADLINE_LIMIT });
    expect(() => roundTrip(flipped)).toThrow("bad deadline");
    // The extremes that remain legal round-trip cleanly.
    const edges = match({
      p2: P2,
      moveTimeout: MAX_MOVE_TIMEOUT_DAA,
      deadline: DEADLINE_LIMIT - 1,
    });
    expectEqual(edges, roundTrip(edges));
  });

  test("joined flag with an all-zero p2 is rejected", () => {
    const good = encodeMatchBinary(match({ p2: P2 }));
    // joined layout: flags(1) + covenantId(32) + txid(32) + p1(32), then p2.
    const bad = Uint8Array.from(good.map((x, i) => (i >= 97 && i < 129 ? 0 : x)));
    expect(() => decodeMatchBinary(bad)).toThrow("zero p2");
  });
});
