/**
 * Cross-mode building blocks: the join re-derivation every mode shares and
 * the permissionless split doors both rule sets declare (claim_draw /
 * sudden_death — same selector names, same pinned-payout shape).
 */

import { toHex, type Match } from "../lib/match";
import { CELLS, isOpen, type State } from "../lib/game";
import * as engine from "../lib/engine";
import { ensureFunds } from "../lib/dispenser";
import type { AutoAction, GameMode } from "./types";

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
      return "Time's up — the game hit its total time limit and the pot split evenly.";
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

export async function drawMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  mode: GameMode,
  match: Match,
): Promise<string> {
  return engine.pinnedSplit(rpc, key, mode, match, "claim_draw", []);
}

/** Split a capped game that outlived its deadline; the tx's lockTime proves
 * the chain has passed the deadline — the node simply won't mine it early. */
export async function suddenDeathMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  mode: GameMode,
  match: Match,
): Promise<string> {
  return engine.pinnedSplit(rpc, key, mode, match, "sudden_death", [], {
    lockTime: BigInt(match.state.deadline),
  });
}

export const DRAW_MESSAGE = "It's a draw — the board filled up with no winner.";
export const SUDDEN_DEATH_MESSAGE =
  "Time's up — the game hit its total time limit and the pot split evenly.";

/**
 * The automatic duties every mode shares: a full board settles itself as a
 * draw, and a capped game settles itself once the chain passes its deadline
 * — either player's client cranks the permissionless door, and losing the
 * race to the opponent's client is success too.
 */
export function sharedAutoActions(mode: GameMode, m: Match): AutoAction[] {
  const out: AutoAction[] = [];
  if (isOpen(m.state)) return out;
  if (m.state.moveCount >= CELLS)
    out.push({
      key: "draw",
      oncePer: "match",
      run: async (rpc, key, mm) => {
        await ensureFunds(rpc, key, engine.FEE_HEADROOM);
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
      run: async (rpc, key, mm) => {
        await ensureFunds(rpc, key, engine.FEE_HEADROOM);
        await suddenDeathMatch(rpc, key, mode, mm);
        return { kind: "finished", message: SUDDEN_DEATH_MESSAGE };
      },
      onTerminated: SUDDEN_DEATH_MESSAGE,
    });
  return out;
}
