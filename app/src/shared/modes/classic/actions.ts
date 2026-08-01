/**
 * Classic mode, player actions. The win claim is merged into the move
 * (`winning_move`): a completed win can never sit unclaimed while the
 * opponent races the board toward a draw.
 */

import { applyMove, discOf, findWin, playerToMove, type LineWitness } from "../../lib/game";
import type { Match } from "../../lib/match";
import * as engine from "../../lib/engine";
import { ensureFunds } from "../../lib/dispenser";
import type { DropResult, ModeActions } from "../types";
import { classicEngine } from "./engine";

export async function moveMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  col: number,
): Promise<Match> {
  return engine.continuation(
    rpc,
    key,
    classicEngine,
    match,
    "move",
    () => ({ ints: [col] }),
    { state: applyMove(match.state, col) },
    0n,
  );
}

/** Play a disc AND claim the four-in-a-row it completes (or an earlier
 * unclaimed one). The signer owns the whole pot and directs it freely. */
export async function winMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
  col: number,
  w: LineWitness,
): Promise<string> {
  return engine.signedTerminal(rpc, key, classicEngine, match, "winning_move", [
    col,
    w.col,
    w.row,
    w.dir,
  ]);
}

/** The waiting player takes the pot once the mover's clock lapses. */
export async function forfeitMatch(
  rpc: engine.Rpc,
  key: engine.PrivateKey,
  match: Match,
): Promise<string> {
  return engine.signedTerminal(
    rpc,
    key,
    classicEngine,
    match,
    "claim_forfeit",
    [],
    BigInt(match.state.moveTimeout),
  );
}

export const classicActions: ModeActions = {
  /** A drop is a move — or a winning_move when the disc completes four in a
   * row (the claim is merged so a win can never sit unclaimed while the
   * opponent races toward a draw). */
  async drop(rpc, key, match, col): Promise<DropResult> {
    const next = applyMove(match.state, col);
    const witness = findWin(next.board, discOf(playerToMove(match.state)));
    if (witness) {
      const txid = await winMatch(rpc, key, match, col, witness);
      return {
        kind: "ended",
        match: { ...match, state: next, txid },
        message: "You connected four — you win! 🎉",
      };
    }
    // A move's fee comes off a wallet UTXO; refill from the dispenser if the
    // wallet has run dry mid-game.
    await ensureFunds(rpc, key, engine.FEE_HEADROOM);
    return { kind: "continued", match: await moveMatch(rpc, key, match, col) };
  },

  claimTimeout: forfeitMatch,
};
