/**
 * Game logic bridge: re-export the TypeScript reference implementation
 * (fourk/src — the single source of truth for the rules) and add the few
 * helpers the UI needs on top: unauthenticated move application (for
 * predicting successors regardless of whose key we hold) and a win scanner.
 */

import {
  CELLS,
  COLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  MOVE_TIMEOUT_DAA,
  ROWS,
  ZERO_PK,
  cellIndex,
  discOf,
  heightOf,
  isOpen,
  playerToMove,
  pubkeyOf,
  type State,
} from "../../../../src/state";
import { DIRS, move, verifyLine, type LineWitness } from "../../../../src/rules";

export {
  CELLS,
  COLS,
  DEADLINE_LIMIT,
  MAX_MOVE_TIMEOUT_DAA,
  MIN_MOVE_TIMEOUT_DAA,
  MOVE_TIMEOUT_DAA,
  ROWS,
  ZERO_PK,
  cellIndex,
  discOf,
  heightOf,
  isOpen,
  playerToMove,
  DIRS,
};
export type { State, LineWitness };

export function legalColumns(s: State): number[] {
  if (isOpen(s) || s.moveCount >= CELLS) return [];
  return [...Array(COLS).keys()].filter((c) => heightOf(s.board, c) < ROWS);
}

/** Apply a move without signature checks — used to enumerate successors.
 * The mover's own key stands in as signer, so only the rulebook's board
 * legality applies. */
export function applyMove(s: State, col: number): State {
  return move(s, { signer: pubkeyOf(s, playerToMove(s)), utxoAge: 0, txTime: 0 }, col);
}

/** First four-in-a-row witness for `disc`, or null. */
export function findWin(board: Uint8Array, disc: number): LineWitness | null {
  for (let col = 0; col < COLS; col++)
    for (let row = 0; row < ROWS; row++)
      for (let dir = 0; dir < DIRS.length; dir++) {
        const w = { col, row, dir };
        if (verifyLine(board, disc, w)) return w;
      }
  return null;
}
