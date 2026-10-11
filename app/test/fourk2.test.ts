/**
 * Fourk V2's app surface without a chain: the shared clock the seats count
 * down, the joined lobby where the first picks happen, lateness read off the
 * acceptance stamp, and the engine's enumeration / re-derivation rules.
 */

import { describe, expect, test, vi } from "vitest";
import { ZERO_PK, type State } from "../src/shared/lib/game";
import type { Match } from "../src/shared/lib/match";
import { fourk2Mode } from "../src/shared/modes/fourk2";
import { zeroCore2, type SimulCore2 } from "../src/shared/modes/fourk2/core";
import { fresherOf, modeOf, parseModeKey } from "../src/shared/modes/registry";
import type { ViewCtx } from "../src/shared/modes/types";

const bag = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => bag.get(k) ?? null,
  setItem: (k: string, v: string) => void bag.set(k, String(v)),
  removeItem: (k: string) => void bag.delete(k),
});

const P1 = "11".repeat(32);
const P2 = "22".repeat(32);
const HASH = "ef".repeat(32);
const HASH2 = "ac".repeat(32);

function at(
  core: Partial<SimulCore2> = {},
  over: Partial<Match> = {},
  state: Partial<State> = {},
): Match {
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
    network: "simnet",
    covenantId: "ab".repeat(32),
    txid: "cd".repeat(32),
    state: s,
    value: s.p2 === ZERO_PK ? s.stake : s.stake * 2n,
    mode: "fourk2",
    simul: { ...zeroCore2(600), ...core },
    ...over,
  };
}

const ctx = (role: ViewCtx["role"], clockExpired = false): ViewCtx => ({
  myPk: role === "p1" ? P1 : role === "p2" ? P2 : "",
  role,
  clockExpired,
  busy: false,
  pendingCol: null,
  result: null,
});

const twoDiscs = (() => {
  const board = new Uint8Array(42);
  board[0] = 1;
  board[6] = 2;
  return { board, moveCount: 2 };
})();
/** The second round's start (one disc each landed in the first). */
const started = at({ round: 1 }, {}, twoDiscs);
const later = (core: Partial<SimulCore2>, over: Partial<Match> = {}) =>
  at({ round: 1, ...core }, over, twoDiscs);
const one = { commit1: HASH, pickDeadline: 6200, firstCommitter: 1 };
const two = { ...one, commit2: HASH };
/** The first round: the lone pick carries no cutoff, the second pick's
 * window runs from the lone pick's own acceptance. */
const firstOne = { commit1: HASH, pickDeadline: 0, firstCommitter: 1 };
const firstTwo = { ...firstOne, commit2: HASH, pickDeadline: 6200 };

describe("fourk2 clock", () => {
  test("follows the round: age until a commit, absolute cutoff, reveal grace", () => {
    expect(fourk2Mode.clock(started)).toEqual({ kind: "age", daa: 1200 });
    expect(fourk2Mode.clock(later(one))).toEqual({ kind: "absolute", daa: 6200 });
    // Once the first commit's acceptance is known, the claim waits for the
    // rebase grace after it when that is later than the cutoff.
    expect(fourk2Mode.clock(later(one, { acceptedDaa: 6150 }))).toEqual({
      kind: "absolute",
      daa: 6250,
    });
    expect(fourk2Mode.clock(later(one, { acceptedDaa: 5000 }))).toEqual({
      kind: "absolute",
      daa: 6200,
    });
    expect(fourk2Mode.clock(later(two))).toEqual({ kind: "age", daa: 600 });
    expect(fourk2Mode.clock(later({ commit2: HASH, reveal1: 4 }))).toEqual({
      kind: "age",
      daa: 600,
    });
    expect(fourk2Mode.clock(later({ pendingWin: 1 }))).toBeNull();
    // A lone commit accepted after the cutoff decides the round (a draw).
    expect(fourk2Mode.clock(later(one, { acceptedDaa: 6201 }))).toBeNull();
  });

  test("the first round: no lobby clock, the lone pick's window once its acceptance is known", () => {
    expect(fourk2Mode.clock(at())).toBeNull();
    expect(fourk2Mode.clock(at(firstOne))).toBeNull();
    expect(fourk2Mode.clock(at(firstOne, { acceptedDaa: 5000 }))).toEqual({
      kind: "absolute",
      daa: 6200,
    });
    expect(fourk2Mode.clock(at(firstTwo))).toEqual({ kind: "age", daa: 600 });
  });
});

describe("fourk2 view", () => {
  test("the joined lobby is where both players pick; the first pick closes it", () => {
    const lobby = at();
    expect(fourk2Mode.inLobby(lobby)).toBe(true);
    expect(fourk2Mode.roundStarted(lobby)).toBe(false);
    for (const role of ["p1", "p2"] as const) {
      const v = fourk2Mode.view(lobby, ctx(role));
      expect(v.status.segments[0]!.text).toBe("Pick a column");
      expect(v.status.segments[1]!.text).toMatch(/first pick to land starts/);
      expect(v.board.interactive).toBe(true);
      expect(v.seats.every((seat) => seat.active && !seat.showClock)).toBe(true);
    }
    expect(fourk2Mode.isActionable(lobby, P1)).toBe(true);
    expect(fourk2Mode.isActionable(lobby, P2)).toBe(true);
    const picked = at(firstOne, { acceptedDaa: 5000 });
    expect(fourk2Mode.inLobby(picked)).toBe(false);
    expect(fourk2Mode.roundStarted(picked)).toBe(true);
    expect(fourk2Mode.view(picked, ctx("p1")).status.segments[0]!.text).toMatch(/Pick saved/);
    expect(fourk2Mode.view(picked, ctx("p2")).status.segments[0]!.text).toBe("Pick a column");
    expect(fourk2Mode.view(picked, ctx("p2")).seats[1]!.showClock).toBe(true);
    expect(fourk2Mode.isActionable(picked, P1)).toBe(false);
    expect(fourk2Mode.isActionable(picked, P2)).toBe(true);
    expect(fourk2Mode.inLobby(started)).toBe(false);
    expect(fourk2Mode.view(started, ctx("p1")).status.segments[1]!.text).toMatch(/shared timer/);
  });

  test("the first round never offers a timeout claim; a stall is called off", () => {
    const stalled = at(firstOne, { acceptedDaa: 5000 });
    expect(fourk2Mode.view(stalled, ctx("p1", true)).canClaimTimeout).toBe(false);
    expect(fourk2Mode.view(stalled, ctx("p1", true)).status.segments[1]!.text).toMatch(
      /called off/,
    );
    expect(fourk2Mode.view(stalled, ctx("p2", true)).status.segments[0]!.text).toBe(
      "Your time is up",
    );
    expect(fourk2Mode.view(stalled, ctx("p2", true)).status.segments[1]!.text).toMatch(
      /called off/,
    );
    const late = at(firstTwo, { acceptedDaa: 6201 });
    for (const role of ["p1", "p2"] as const) {
      const v = fourk2Mode.view(late, ctx(role));
      expect(v.canClaimTimeout).toBe(false);
      expect(v.status.segments[1]!.text).toMatch(/called off/);
      expect(v.board.interactive).toBe(false);
    }
    expect(fourk2Mode.view(at(firstTwo, { acceptedDaa: 6200 }), ctx("p1")).canClaimTimeout).toBe(
      false,
    );
    // A reveal on the table is a proven obligation even in the first round.
    const shown = at({ commit2: HASH, reveal1: 4 });
    expect(fourk2Mode.view(shown, ctx("p1", true)).canClaimTimeout).toBe(true);
    const split = { kind: "split_timeout", txid: "", pushes: [], args: [], payload: "" } as const;
    expect(fourk2Mode.describeEnd(split, stalled, P1)).toMatch(/second pick never landed/);
    expect(fourk2Mode.describeEnd(split, late, P2)).toMatch(/after the deadline/);
    expect(fourk2Mode.describeEnd(split, started, P1)).toMatch(/Neither player picked/);
  });

  test("a late second commit hands the first committer the claim from the second round on", () => {
    const late = later(two, { acceptedDaa: 6201 });
    const first = fourk2Mode.view(late, ctx("p1"));
    expect(first.canClaimTimeout).toBe(true);
    expect(first.status.segments[0]!.text).toMatch(/opponent's pick arrived too late/);
    const second = fourk2Mode.view(late, ctx("p2"));
    expect(second.canClaimTimeout).toBe(false);
    expect(second.status.tone).toBe("danger");
    expect(second.seats.every((seat) => !seat.showClock)).toBe(true);
    // Timely: both owe a reveal, nobody can claim yet.
    const timely = later(two, { acceptedDaa: 6200 });
    expect(fourk2Mode.view(timely, ctx("p1")).canClaimTimeout).toBe(false);
    expect(
      fourk2Mode.describeEnd(
        { kind: "claim_timeout", txid: "", pushes: [], args: [], payload: "" },
        late,
        P1,
      ),
    ).toMatch(/You win/);
    expect(
      fourk2Mode.describeEnd(
        { kind: "claim_timeout", txid: "", pushes: [], args: [], payload: "" },
        late,
        P2,
      ),
    ).toMatch(/opponent claimed/);
  });

  test("the timeout claim on a lone pick waits for the expired shared clock", () => {
    const m = later(one);
    expect(fourk2Mode.view(m, ctx("p1")).canClaimTimeout).toBe(false);
    expect(fourk2Mode.view(m, ctx("p1", true)).canClaimTimeout).toBe(true);
    expect(fourk2Mode.view(m, ctx("p2", true)).canClaimTimeout).toBe(false);
    expect(fourk2Mode.view(m, ctx("p2", true)).status.segments[0]!.text).toBe("Your time is up");
    expect(fourk2Mode.view(m, ctx("p2", true)).status.segments[1]!.text).toMatch(/claim the win/);
    expect(fourk2Mode.view(started, ctx("p2", true)).status.segments[0]!.text).toBe("Time is up");
  });
});

describe("fourk2 engine", () => {
  test("commits stay blind, rounds enumerate as before", () => {
    expect(fourk2Mode.canEnumerate(at())).toBe(false);
    expect(fourk2Mode.successors(at())).toEqual([]);
    expect(fourk2Mode.canEnumerate(started)).toBe(false);
    expect(fourk2Mode.successors(started)).toEqual([]);
    expect(fourk2Mode.canEnumerate(later(two))).toBe(true);
    expect(fourk2Mode.successors(later(two))).toHaveLength(14);
    for (const next of fourk2Mode.successors(later(two)))
      expect((next.simul as SimulCore2).pickDeadline).toBe(0);
    expect(fourk2Mode.successors(at(firstTwo))).toHaveLength(14);
  });

  test("re-deriving a commit needs the spent UTXO's acceptance score", () => {
    const pk = Uint8Array.from(Buffer.from(P2, "hex"));
    const hash = Uint8Array.from(Buffer.from(HASH, "hex"));
    const spend = {
      kind: "commit",
      txid: "",
      pushes: [new Uint8Array(65), pk, hash],
      args: [],
      payload: "",
    };
    expect(fourk2Mode.needsAcceptedDaa!(started, spend)).toBe(true);
    expect(fourk2Mode.rederiveSpend(started, spend)).toBeNull();
    const derived = fourk2Mode.rederiveSpend({ ...started, acceptedDaa: 5000 }, spend)!;
    expect(derived.simul).toMatchObject({ commit2: HASH, pickDeadline: 6200, firstCommitter: 2 });
    // The successor is unobserved: no stamp rides along.
    expect(derived.acceptedDaa).toBe(5000);
    // The first round: the lone pick stores no cutoff (it still needs the
    // join's score for the cap check), the second stores S1 + T.
    expect(fourk2Mode.rederiveSpend(at(), spend)).toBeNull();
    const lone = fourk2Mode.rederiveSpend({ ...at(), acceptedDaa: 5000 }, spend)!;
    expect(lone.simul).toMatchObject({ commit2: HASH, pickDeadline: 0, firstCommitter: 2 });
    const pk1 = Uint8Array.from(Buffer.from(P1, "hex"));
    const other = Uint8Array.from(Buffer.from(HASH2, "hex"));
    const answer = fourk2Mode.rederiveSpend(
      { ...at({ commit2: HASH, firstCommitter: 2 }), acceptedDaa: 7000 },
      { ...spend, pushes: [new Uint8Array(65), pk1, other] },
    )!;
    expect(answer.simul).toMatchObject({ commit1: HASH2, pickDeadline: 8200, firstCommitter: 2 });
  });

  test("progress follows the round key", () => {
    const a = at();
    const b = at(firstOne);
    const c = later(one);
    expect(fresherOf(a, b)).toBe(b);
    expect(fresherOf(c, b)).toBe(c);
    expect(fresherOf(started, b)).toBe(started);
  });

  test("duties: the lobby keeps its manual exits, stalled rounds split themselves", () => {
    const keys = (m: Match, role: "p1" | "p2" = "p1") =>
      fourk2Mode.autoActions(m, { myPk: role === "p1" ? P1 : P2, role }).map((a) => a.key);
    // Only the cap crank applies to the joined lobby (an abandoned one still
    // gets cleaned up at the deadline); kick and cancel are buttons.
    expect(keys(at())).toEqual(["sudden-death"]);
    expect(keys(started)).toContain("no-picks");
    expect(keys(later(one))).not.toContain("no-picks");
    expect(keys(later(one, { acceptedDaa: 6201 }))).toContain("late-pick");
    // Both picked but this browser holds no salt: the reveal grace split.
    expect(keys(later(two))).toContain("no-reveals");
    expect(keys(later(two, { acceptedDaa: 6201 }))).not.toContain("no-reveals");
    // The first round's refunds: an unanswered lone pick, a late second pick.
    expect(keys(at(firstOne))).toContain("first-round-stall");
    expect(keys(at(firstOne))).not.toContain("late-pick");
    expect(keys(at(firstTwo, { acceptedDaa: 6201 }))).toContain("first-round-late");
    expect(keys(at(firstTwo, { acceptedDaa: 6201 }))).not.toContain("no-reveals");
    expect(keys(at(firstTwo, { acceptedDaa: 6200 }))).toContain("no-reveals");
    expect(keys(started)).toContain("sudden-death");
    expect(keys(started).filter((k) => k === "sudden-death")).toHaveLength(1);
  });
});

describe("registry", () => {
  test("new games host on fourk2; a remembered legacy setting hosts fourk2", () => {
    expect(parseModeKey("fourk")).toBe("fourk2");
    expect(parseModeKey("classic")).toBe("classic");
    expect(parseModeKey(null)).toBe("fourk2");
    expect(modeOf(at()).meta.key).toBe("fourk2");
  });
});
