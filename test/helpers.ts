import { State, newMatch } from "../src/state.js";
import { Ctx, join, move } from "../src/rules.js";

export const P1 = "11".repeat(32);
export const P2 = "22".repeat(32);
export const STRANGER = "33".repeat(32);
export const STAKE = 100_000_000n; // 1 KAS

export function ctx(signer: string, utxoAge = 0, txTime = 0): Ctx {
  return { signer, utxoAge, txTime };
}

/** A joined match, ready to play. */
export function game(): State {
  return join(newMatch(P1, STAKE), ctx(P2));
}

/** Play a sequence of columns with correct alternation. */
export function play(s: State, cols: number[]): State {
  for (const c of cols) s = move(s, ctx(s.moveCount % 2 === 0 ? P1 : P2), c);
  return s;
}

/** Fill the whole board legally: 42 moves, columns left to right. */
export function fillBoard(s: State): State {
  const cols: number[] = [];
  for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) cols.push(c);
  return play(s, cols);
}
