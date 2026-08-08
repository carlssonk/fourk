import { describe, expect, test } from "vitest";
import { claimTimeoutGate, viewFlags } from "../app/src/shared/modes/common";
import type { ViewCtx } from "../app/src/shared/modes/types";
import { CELLS, ZERO_PK, type State } from "../app/src/shared/lib/game";
import type { Match } from "../app/src/shared/lib/match";

const P1 = "11".repeat(32);
const P2 = "22".repeat(32);
const COV = "ab".repeat(32);
const TXID = "cd".repeat(32);

function match(state: Partial<State>): Match {
  const s: State = {
    p1: P1,
    p2: P2,
    board: new Uint8Array(CELLS),
    moveCount: 0,
    stake: 100_000_000n,
    moveTimeout: 36_000,
    deadline: 500_000,
    ...state,
  };
  return { network: "testnet-10", covenantId: COV, txid: TXID, state: s, value: s.stake * 2n };
}

function ctx(over: Partial<ViewCtx> = {}): ViewCtx {
  return {
    myPk: P1,
    role: "p1",
    clockExpired: false,
    busy: false,
    pendingCol: null,
    result: null,
    ...over,
  };
}

describe("viewFlags", () => {
  test("joined match in play: not open, not full, playing", () => {
    expect(viewFlags(match({ moveCount: 3 }), ctx())).toEqual({
      open: false,
      full: false,
      playing: true,
    });
  });

  test("open seat: open, not playing", () => {
    const f = viewFlags(match({ p2: ZERO_PK }), ctx());
    expect(f.open).toBe(true);
    expect(f.playing).toBe(false);
  });

  test("full board still counts as playing until a result lands", () => {
    expect(viewFlags(match({ moveCount: CELLS }), ctx())).toEqual({
      open: false,
      full: true,
      playing: true,
    });
  });

  test("a result ends playing", () => {
    expect(viewFlags(match({}), ctx({ result: "done" })).playing).toBe(false);
  });
});

describe("claimTimeoutGate", () => {
  const owedNothing = { started: true, notOwed: true };
  const live = () => viewFlags(match({ moveCount: 3 }), ctx());

  test("opens when live, seated, started, expired, and owed nothing", () => {
    expect(claimTimeoutGate(live(), ctx({ clockExpired: true }), owedNothing)).toBe(true);
  });

  test("shut while the clock still runs", () => {
    expect(claimTimeoutGate(live(), ctx(), owedNothing)).toBe(false);
  });

  test("shut for spectators", () => {
    expect(
      claimTimeoutGate(live(), ctx({ role: "spectator", clockExpired: true }), owedNothing),
    ).toBe(false);
  });

  test("shut when the claimant still owes the round (classic: my turn)", () => {
    expect(
      claimTimeoutGate(live(), ctx({ clockExpired: true }), { started: true, notOwed: false }),
    ).toBe(false);
  });

  test("shut before the round has started", () => {
    expect(
      claimTimeoutGate(live(), ctx({ clockExpired: true }), { started: false, notOwed: true }),
    ).toBe(false);
  });

  test("shut on an open seat, a full board, or after a result", () => {
    const expired = ctx({ clockExpired: true });
    expect(claimTimeoutGate(viewFlags(match({ p2: ZERO_PK }), expired), expired, owedNothing)).toBe(
      false,
    );
    expect(
      claimTimeoutGate(viewFlags(match({ moveCount: CELLS }), expired), expired, owedNothing),
    ).toBe(false);
    const done = ctx({ clockExpired: true, result: "done" });
    expect(claimTimeoutGate(viewFlags(match({}), done), done, owedNothing)).toBe(false);
  });
});
