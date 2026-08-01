import { DIRS, cellIndex, findWin, type LineWitness } from "@shared/lib/game";

export type ResultTone = "win" | "loss" | "neutral";

/** Classify an ending message for the verdict card. The strings come from
 * the modes' describeEnd and the finish() calls: a personal victory always
 * says "you win", a defeat mentions a win that isn't ours, and everything
 * else (draws, splits, dissolves, cancels) is nobody's victory. */
export function resultTone(result: string): ResultTone {
  if (result.includes("you win")) return "win";
  if (result.includes("win")) return "loss";
  return "neutral";
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
