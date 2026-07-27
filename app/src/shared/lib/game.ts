/**
 * Game logic bridge: re-export the TypeScript reference implementation
 * (fourk/src — the single source of truth for the rules) and add the few
 * helpers the UI needs on top: unauthenticated move application (for
 * predicting successors regardless of whose key we hold) and a win scanner.
 */

import {
  CELLS,
  COLS,
  MIN_MOVE_TIMEOUT_DAA,
  MOVE_TIMEOUT_DAA,
  ROWS,
  ZERO_PK,
  cellIndex,
  discOf,
  heightOf,
  isOpen,
  playerToMove,
  type State,
} from "../../../../src/state";
import { DIRS, verifyLine, type LineWitness } from "../../../../src/rules";

export {
  CELLS,
  COLS,
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

/** Apply a move without signature checks — used to enumerate successors. */
export function applyMove(s: State, col: number): State {
  const h = heightOf(s.board, col);
  if (isOpen(s) || s.moveCount >= CELLS || h >= ROWS) throw new Error(`illegal move in column ${col}`);
  const board = s.board.slice();
  board[cellIndex(col, h)] = discOf(playerToMove(s));
  return { ...s, board, moveCount: s.moveCount + 1 };
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
