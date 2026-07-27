import * as cov from "@shared/lib/covenant";
import {
  CELLS,
  DIRS,
  cellIndex,
  findWin,
  isOpen,
  playerToMove,
  type LineWitness,
} from "@shared/lib/game";
import type { Match } from "@shared/lib/match";

export interface MatchView {
  open: boolean;
  full: boolean;
  role: "p1" | "p2" | "spectator";
  iAmPlayer: boolean;
  /** Player index (0/1) whose turn it is. */
  mover: number;
  /** It's my move — before accounting for a finished result. */
  wantsMove: boolean;
}

/** Everything the game screen derives from the raw match. */
export function matchView(match: Match, myPk: string): MatchView {
  const s = match.state;
  const open = isOpen(s);
  const full = s.moveCount >= CELLS;
  const role = cov.myRole(match, myPk);
  return {
    open,
    full,
    role,
    iAmPlayer: role !== "spectator",
    mover: playerToMove(s),
    wantsMove: !open && !full && cov.isMyTurn(match, myPk),
  };
}

function lineCells(w: LineWitness): number[] {
  const [dc, dr] = DIRS[w.dir]!;
  return [0, 1, 2, 3].map((k) => cellIndex(w.col + k * dc, w.row + k * dr));
}

/** Cells of any four-in-a-row on the board, highlighted as the win. */
export function winningCells(board: Uint8Array): Set<number> {
  const cells = new Set<number>();
  for (const disc of [1, 2]) {
    const w = findWin(board, disc);
    if (w) for (const i of lineCells(w)) cells.add(i);
  }
  return cells;
}
