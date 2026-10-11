import { DIRS, cellIndex, findWin, type LineWitness } from "@shared/lib/game";

export { resultTone, type ResultTone } from "@shared/lib/result";

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
