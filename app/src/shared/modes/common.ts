/**
 * Cross-mode building blocks: the join re-derivation every mode shares and
 * the permissionless split doors both rule sets declare (claim_draw /
 * sudden_death — same selector names, same pinned-payout shape).
 */

import { toHex, type Match } from "../lib/match";
import { CELLS, isOpen, type State } from "../lib/game";
import * as engine from "../lib/engine";
import type { AutoAction, GameMode, ViewCtx } from "./types";

/** A join spend's successor: the joiner's pubkey is the sig script's first
 * 32-byte push; the mode's joinFields ride along. Null for anything else. */
export function rederiveJoin(
  m: Match,
  spend: engine.SpendInfo,
  joinFields: Partial<Match>,
): Match | null {
  if (spend.kind !== "join") return null;
  const pk = spend.pushes.find((p) => p.length === 32);
  if (!pk) return null;
  const state: State = { ...m.state, board: m.state.board.slice(), p2: toHex(pk) };
  // txid/value stay stale — the adopter attaches the on-chain hit.
  return { ...m, state, ...joinFields };
}

/**
 * Ending copy for the doors both modes declare. The spend spent exactly
 * `m.txid`, so m.state is the true pre-spend state. Returns null for kinds
 * the mode must describe itself.
 */
export function describeSharedEnd(
  spend: engine.SpendInfo | null,
  m: Match,
  myPk: string,
): string | null {
  switch (spend?.kind) {
    case "claim_draw":
      return "It's a draw — the board filled up with no winner.";
    case "cancel":
      return "The game was called off before anyone joined.";
    case "sudden_death":
      return suddenDeathMessage(m);
    case "dissolve": {
      // The dissolve call pushes the dissolving player's pubkey — read it to
      // tell a kick from a walk-out.
      const signer = spend.pushes.find((p) => p.length === 32);
      const by = signer ? toHex(signer) : null;
      if (by === myPk) return "The game was dissolved — both stakes returned.";
      if (myPk === m.state.p2 && by === m.state.p1)
        return "Your opponent called the game off — your stake is on its way back.";
      if (myPk === m.state.p1 && by === m.state.p2)
        return "Your opponent left before the game began — your stake is on its way back.";
      return "The game was dissolved before the first move — both stakes returned.";
    }
    default:
      return null;
  }
}

/** The catch-all ending line for spends nobody can attribute. */
export const GENERIC_END = "The game has ended.";

/** The stance every view derives first: seat still open, board full, play
 * live on screen. */
export interface ViewFlags {
  open: boolean;
  full: boolean;
  playing: boolean;
}

export function viewFlags(m: Match, ctx: ViewCtx): ViewFlags {
  const open = isOpen(m.state);
  return { open, full: m.state.moveCount >= CELLS, playing: !open && !ctx.result };
}

/**
 * "May I claim the clock" — the part both rule sets agree on: a live board,
 * a seat (not a spectator), a started round, an expired clock. Each mode
 * supplies the two facts that differ: whether its round has started, and
 * that the claimant owes the round nothing (classic: not my turn; fourk: no
 * obligation and the opponent hasn't acted).
 */
export function claimTimeoutGate(
  f: ViewFlags,
  ctx: ViewCtx,
  mode: { started: boolean; notOwed: boolean },
): boolean {
  return (
    !f.open &&
    !f.full &&
    ctx.role !== "spectator" &&
    !ctx.result &&
    mode.started &&
    ctx.clockExpired &&
    mode.notOwed
  );
}

export async function drawMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  mode: GameMode,
  match: Match,
): Promise<string> {
  return engine.pinnedSplit(rpc, key, mode, match, "claim_draw", []);
}

/** Settle a capped game that outlived its deadline; the tx's lockTime proves
 * the chain has passed the deadline — the node simply won't mine it early.
 * Almost always an even split, but on a pending win (a claimed, not-yet-swept
 * fourk win) the covenant pays the winner in FULL instead — so a vanished
 * winner's pot is pushed to them, not halved by a loser stalling to the cap. */
export async function suddenDeathMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  mode: GameMode,
  match: Match,
): Promise<string> {
  const lockTime = BigInt(match.state.deadline);
  const pendingWin = match.simul?.pendingWin ?? 0;
  if (pendingWin !== 0) {
    const winnerPk = pendingWin === 1 ? match.state.p1 : match.state.p2;
    return engine.pinnedWinner(rpc, mode, match, "sudden_death", winnerPk, { lockTime });
  }
  return engine.pinnedSplit(rpc, key, mode, match, "sudden_death", [], { lockTime });
}

export const DRAW_MESSAGE = "It's a draw — the board filled up with no winner.";
export const SUDDEN_DEATH_MESSAGE =
  "Time's up — the game hit its total time limit and the pot split evenly.";
export const SUDDEN_DEATH_WIN_MESSAGE =
  "Time's up — the game hit its total time limit and the winner took the pot.";

/** Sudden death splits an undecided game but pays a pending winner in full;
 * the ending copy has to match whichever the covenant did. */
export function suddenDeathMessage(m: Match): string {
  return (m.simul?.pendingWin ?? 0) !== 0 ? SUDDEN_DEATH_WIN_MESSAGE : SUDDEN_DEATH_MESSAGE;
}

/**
 * The automatic duties every mode shares: a full board settles itself as a
 * draw, and a capped game settles itself once the chain passes its deadline
 * — either player's client cranks the permissionless door, and losing the
 * race to the opponent's client is success too.
 */
export function sharedAutoActions(mode: GameMode, m: Match): AutoAction[] {
  const out: AutoAction[] = [];
  if (isOpen(m.state)) return out;
  // A pending win outranks the draw (the covenant gates claim_draw on it):
  // a full board with an open challenge window settles via contest/sweep.
  const pendingWin = (m.simul?.pendingWin ?? 0) !== 0;
  if (m.state.moveCount >= CELLS && !pendingWin)
    out.push({
      key: "draw",
      oncePer: "match",
      // Fourk's claim_draw waits out a move clock: a board-filling resolve can
      // hide a just-completed win, so the covenant hands that win's owner the
      // same window before the permissionless split can settle. Schedule the
      // crank for when the UTXO reaches that age. Classic's draw has no such
      // gate and fires immediately. Either door is self-funded (fee from the
      // pot), so no wallet top-up is needed to crank it.
      ...(m.simul && {
        scheduleMs: async (rpc) => {
          const age = await engine.gameUtxoAge(rpc, mode, m);
          return Math.max(0, (m.state.moveTimeout - (age ?? 0)) * 100 + 2000);
        },
      }),
      run: async (rpc, key, mm) => {
        await drawMatch(rpc, key, mode, mm);
        return { kind: "finished", message: DRAW_MESSAGE };
      },
      onTerminated: DRAW_MESSAGE,
    });
  if (m.state.deadline > 0)
    out.push({
      key: "sudden-death",
      oncePer: "match",
      scheduleMs: async (rpc) => {
        const info: any = await rpc.getBlockDagInfo();
        // Past-deadline claims fire now; the +2s pad lets the node's clock
        // catch up before the lockTime-gated tx is submitted.
        return Math.max(0, (m.state.deadline - Number(info.virtualDaaScore)) * 100 + 2000);
      },
      // Self-funded (fee from the pot), so no wallet top-up to crank it.
      run: async (rpc, key, mm) => {
        await suddenDeathMatch(rpc, key, mode, mm);
        return { kind: "finished", message: suddenDeathMessage(mm) };
      },
      onTerminated: suddenDeathMessage(m),
    });
  return out;
}
