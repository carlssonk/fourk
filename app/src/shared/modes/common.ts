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
      return "It's a draw. The board filled up with no winner.";
    case "cancel":
      return "The game was called off before anyone joined.";
    case "sudden_death":
      return suddenDeathMessage(m, myPk);
    case "dissolve": {
      // The dissolve call pushes the dissolving player's pubkey — read it to
      // tell a kick from a walk-out.
      const signer = spend.pushes.find((p) => p.length === 32);
      const by = signer ? toHex(signer) : null;
      if (by === myPk) return "The game was dissolved. Both stakes returned.";
      if (myPk === m.state.p2 && by === m.state.p1)
        return "Your opponent called the game off. Your stake is on its way back.";
      if (myPk === m.state.p1 && by === m.state.p2)
        return "Your opponent left before the game began. Your stake is on its way back.";
      return "The game was dissolved before the first move. Both stakes returned.";
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
  // The fourk draws are age-gated (a board-filling resolve can hide a
  // just-completed win); the sequence field carries the age proof.
  return engine.pinnedSplit(rpc, key, mode, match, "claim_draw", [], {
    sequence: BigInt(mode.drawAge(match)),
  });
}

/** Who the classic cap pays: the player NOT to move once the game has
 * begun and the board is not full (the covenant waits out the mover's clock
 * first, so they are exactly the one a forfeit would make lose); nobody — an
 * even split — on an unmoved or full board. */
export function classicCapWinner(m: Match): string | null {
  const n = m.state.moveCount;
  if (n === 0 || n >= CELLS) return null;
  return n % 2 === 0 ? m.state.p2 : m.state.p1;
}

/** Settle a capped game that outlived its deadline. The lock time proves the
 * chain passed the deadline, the sequence that the mover's clock ran out
 * (the cap never shortens it); the node won't take either early. Modes with
 * their own cap shape (fourk2) supply settleCap. */
export async function suddenDeathMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  mode: GameMode,
  match: Match,
): Promise<string> {
  if (mode.actions.settleCap) return mode.actions.settleCap(rpc, key, match);
  const gates = {
    lockTime: BigInt(match.state.deadline),
    sequence: BigInt(match.state.moveTimeout),
  };
  const winner = classicCapWinner(match);
  if (winner) return engine.pinnedWinner(rpc, mode, match, "sudden_death", winner, gates);
  return engine.pinnedSplit(rpc, key, mode, match, "sudden_death", [], gates);
}

export const DRAW_MESSAGE = "It's a draw. The board filled up with no winner.";
export const SUDDEN_DEATH_MESSAGE =
  "Time's up. The game hit its total time limit and the pot split evenly.";

/** The cap's ending copy, personal like the result classifier expects
 * ("you took" / "your opponent took" read as the win and the loss). */
export function suddenDeathMessage(m: Match, myPk: string): string {
  const winner = classicCapWinner(m);
  if (!winner) return SUDDEN_DEATH_MESSAGE;
  return winner === myPk
    ? "Time's up. The game hit its total time limit and you took the pot."
    : "Time's up. The game hit its total time limit and your opponent took the pot.";
}

/**
 * The automatic duties every mode shares: a full board settles itself as a
 * draw, and a capped game settles itself once the chain passes its deadline
 * — either player's client cranks the permissionless door, and losing the
 * race to the opponent's client is success too.
 */
export function sharedAutoActions(mode: GameMode, m: Match, myPk: string): AutoAction[] {
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
      ...(mode.drawAge(m) > 0 && {
        scheduleMs: async (rpc) => {
          const age = await engine.gameUtxoAge(rpc, mode, m);
          return Math.max(0, (mode.drawAge(m) - (age ?? 0)) * 100 + 2000);
        },
      }),
      run: async (rpc, key, mm) => {
        await drawMatch(rpc, key, mode, mm);
        return { kind: "finished", message: DRAW_MESSAGE };
      },
    });
  if (m.state.deadline > 0)
    out.push({
      key: "sudden-death",
      oncePer: "match",
      // Both gates: the chain past the deadline (lock time) and the game
      // UTXO a full move clock old (sequence). The +2s pad lets the node's
      // clock catch up before the gated tx is submitted.
      scheduleMs: async (rpc) => {
        const info: any = await rpc.getBlockDagInfo();
        const lockWait = m.state.deadline - Number(info.virtualDaaScore);
        const age = await engine.gameUtxoAge(rpc, mode, m);
        const ageWait = age === null ? 30 : m.state.moveTimeout - age;
        return Math.max(0, Math.max(lockWait, ageWait) * 100 + 2000);
      },
      // Self-funded (fee from the pot), so no wallet top-up to crank it.
      run: async (rpc, key, mm) => {
        await suddenDeathMatch(rpc, key, mode, mm);
        return { kind: "finished", message: suddenDeathMessage(mm, myPk) };
      },
    });
  return out;
}
