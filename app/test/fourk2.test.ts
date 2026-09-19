/**
 * Fourk V2's app surface without a chain: the shared clock the seats count
 * down, the readiness lobby, lateness read off the acceptance stamp, and the
 * engine's enumeration / re-derivation rules.
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

const started = { readyMask: 3 };
const one = { readyMask: 3, commit1: HASH, pickDeadline: 6200, firstCommitter: 1 };
const two = { ...one, commit2: HASH };

describe("fourk2 clock", () => {
  test("follows the round: age until a commit, absolute cutoff, reveal grace", () => {
    expect(fourk2Mode.clock(at({ readyMask: 1 }))).toBeNull();
    expect(fourk2Mode.clock(at(started))).toEqual({ kind: "age", daa: 1200 });
    expect(fourk2Mode.clock(at(one))).toEqual({ kind: "absolute", daa: 6200 });
    // Once the first commit's acceptance is known, the claim waits for the
    // rebase grace after it when that is later than the cutoff.
    expect(fourk2Mode.clock(at(one, { acceptedDaa: 6150 }))).toEqual({
      kind: "absolute",
      daa: 6250,
    });
    expect(fourk2Mode.clock(at(one, { acceptedDaa: 5000 }))).toEqual({
      kind: "absolute",
      daa: 6200,
    });
    expect(fourk2Mode.clock(at(two))).toEqual({ kind: "age", daa: 600 });
    expect(fourk2Mode.clock(at({ readyMask: 3, commit2: HASH, reveal1: 4 }))).toEqual({
      kind: "age",
      daa: 600,
    });
    expect(fourk2Mode.clock(at({ readyMask: 3, pendingWin: 1 }))).toBeNull();
    // A lone commit accepted after the cutoff decides the round (a draw).
    expect(fourk2Mode.clock(at(one, { acceptedDaa: 6201 }))).toBeNull();
  });
});

describe("fourk2 view", () => {
  test("the lobby asks each player to ready up and closes at both", () => {
    const lobby = at({ readyMask: 1 });
    expect(fourk2Mode.inLobby(lobby)).toBe(true);
    expect(fourk2Mode.roundStarted(lobby)).toBe(false);
    expect(fourk2Mode.view(lobby, ctx("p1")).canReady).toBe(false);
    expect(fourk2Mode.view(lobby, ctx("p1")).status.segments[0]!.text).toMatch(/Waiting/);
    expect(fourk2Mode.view(lobby, ctx("p2")).canReady).toBe(true);
    expect(fourk2Mode.view(lobby, ctx("p2")).status.segments[0]!.text).toBe("Ready up to start");
    expect(fourk2Mode.view(lobby, ctx("spectator")).canReady).toBe(false);
    const live = at(started);
    expect(fourk2Mode.inLobby(live)).toBe(false);
    expect(fourk2Mode.roundStarted(live)).toBe(true);
    expect(fourk2Mode.view(live, ctx("p1")).canReady).toBe(false);
    expect(fourk2Mode.view(live, ctx("p1")).status.segments[0]!.text).toBe("Pick a column");
    expect(fourk2Mode.isActionable(lobby, P2)).toBe(true);
    expect(fourk2Mode.isActionable(lobby, P1)).toBe(false);
  });

  test("a late second commit hands the first committer the claim", () => {
    const late = at(two, { acceptedDaa: 6201 });
    const first = fourk2Mode.view(late, ctx("p1"));
    expect(first.canClaimTimeout).toBe(true);
    expect(first.status.segments[0]!.text).toMatch(/opponent's pick arrived too late/);
    const second = fourk2Mode.view(late, ctx("p2"));
    expect(second.canClaimTimeout).toBe(false);
    expect(second.status.tone).toBe("danger");
    expect(second.seats.every((seat) => !seat.showClock)).toBe(true);
    // Timely: both owe a reveal, nobody can claim yet.
    const timely = at(two, { acceptedDaa: 6200 });
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
    const m = at(one);
    expect(fourk2Mode.view(m, ctx("p1")).canClaimTimeout).toBe(false);
    expect(fourk2Mode.view(m, ctx("p1", true)).canClaimTimeout).toBe(true);
    expect(fourk2Mode.view(m, ctx("p2", true)).canClaimTimeout).toBe(false);
    expect(fourk2Mode.view(m, ctx("p2", true)).status.segments[0]!.text).toBe("Your time is up");
    expect(fourk2Mode.view(at(started), ctx("p2", true)).status.segments[0]!.text).toBe(
      "Time is up",
    );
  });
});

describe("fourk2 engine", () => {
  test("readiness is enumerable, commits stay blind, rounds enumerate as before", () => {
    const lobby = at();
    expect(fourk2Mode.canEnumerate(lobby)).toBe(true);
    expect(fourk2Mode.successors(lobby).map((m) => (m.simul as SimulCore2).readyMask)).toEqual([
      1, 2,
    ]);
    expect(
      fourk2Mode.successors(at({ readyMask: 2 })).map((m) => (m.simul as SimulCore2).readyMask),
    ).toEqual([3]);
    expect(fourk2Mode.canEnumerate(at(started))).toBe(false);
    expect(fourk2Mode.successors(at(started))).toEqual([]);
    expect(fourk2Mode.canEnumerate(at(two))).toBe(true);
    expect(fourk2Mode.successors(at(two))).toHaveLength(14);
    for (const next of fourk2Mode.successors(at(two)))
      expect((next.simul as SimulCore2).pickDeadline).toBe(0);
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
    const live = at(started);
    expect(fourk2Mode.needsAcceptedDaa!(live, spend)).toBe(true);
    expect(fourk2Mode.rederiveSpend(live, spend)).toBeNull();
    const derived = fourk2Mode.rederiveSpend({ ...live, acceptedDaa: 5000 }, spend)!;
    expect(derived.simul).toMatchObject({ commit2: HASH, pickDeadline: 6200, firstCommitter: 2 });
    // The successor is unobserved: no stamp rides along.
    expect(derived.acceptedDaa).toBe(5000);
    const ready = {
      kind: "ready",
      txid: "",
      pushes: [new Uint8Array(65), pk],
      args: [],
      payload: "",
    };
    expect(
      (fourk2Mode.rederiveSpend(at({ readyMask: 1 }), ready)!.simul as SimulCore2).readyMask,
    ).toBe(3);
  });

  test("progress orders readiness before the round key", () => {
    const a = at({ readyMask: 1 });
    const b = at({ readyMask: 3 });
    const c = at(one);
    expect(fresherOf(a, b)).toBe(b);
    expect(fresherOf(c, b)).toBe(c);
    expect(fourk2Mode.progress(at())).toBeLessThan(fourk2Mode.progress(a));
  });

  test("duties: no readiness automation, stalled rounds split themselves", () => {
    const keys = (m: Match, role: "p1" | "p2" = "p1") =>
      fourk2Mode.autoActions(m, { myPk: role === "p1" ? P1 : P2, role }).map((a) => a.key);
    // Only the cap crank applies to an unstarted lobby (an abandoned one
    // still gets cleaned up at the deadline); readiness is a button.
    expect(keys(at({ readyMask: 1 }))).toEqual(["sudden-death"]);
    expect(keys(at(started))).toContain("no-picks");
    expect(keys(at(one))).not.toContain("no-picks");
    expect(keys(at(one, { acceptedDaa: 6201 }))).toContain("late-pick");
    // Both picked but this browser holds no salt: the reveal grace split.
    expect(keys(at(two))).toContain("no-reveals");
    expect(keys(at(two, { acceptedDaa: 6201 }))).not.toContain("no-reveals");
    expect(keys(at(started))).toContain("sudden-death");
    expect(keys(at(started)).filter((k) => k === "sudden-death")).toHaveLength(1);
  });
});

describe("registry", () => {
  test("new games host on fourk2; legacy fourk records keep their mode", () => {
    expect(parseModeKey("fourk")).toBe("fourk2");
    expect(parseModeKey("classic")).toBe("classic");
    expect(parseModeKey(null)).toBe("fourk2");
    expect(modeOf(at()).meta.key).toBe("fourk2");
    expect(modeOf({ ...at(), mode: "fourk" }).meta.key).toBe("fourk");
  });
});
