import type { Match } from "./match";
import { CELLS, findWin, isOpen } from "./game";

export type ResultTone = "win" | "loss" | "neutral";

export interface GameEnd {
  title: string;
  message: string;
  tone: ResultTone;
  /** The board is decided, but the on-chain ending is still outstanding. */
  settling: boolean;
}

/** Game-facing results are separate from settlement and contain no money copy.
 * Only use the confirmed board, never the optimistic disc or a pending claim
 * alone (a second winning line makes that claim a draw). */
export function gameEnd(m: Match, myPk: string, result = m.result ?? null): GameEnd | null {
  const p1 = findWin(m.state.board, 1);
  const p2 = findWin(m.state.board, 2);
  const boardDecided = !!p1 || !!p2 || m.state.moveCount >= CELLS;
  if (!result && (isOpen(m.state) || m.mode !== "fourk" || !boardDecided)) return null;
  const player = myPk === m.state.p1 || myPk === m.state.p2;
  const settling = !result;
  const draw = (message: string): GameEnd => ({
    title: "It's a draw!",
    message,
    tone: "neutral",
    settling,
  });
  if (!result) {
    if (p1 && p2) return draw("You both connected four in the same round.");
    if (!p1 && !p2) return draw("The board is full.");
    const winner = p1 ? m.state.p1 : m.state.p2;
    const won = winner === myPk;
    const color = p1 ? (m.p1Color ?? "red") : m.p1Color === "blue" ? "red" : "blue";
    return {
      title: player ? (won ? "You win!" : "You lose") : `${color === "red" ? "Red" : "Blue"} wins!`,
      message: player
        ? won
          ? "You connected four."
          : "Your opponent connected four."
        : "Four in a row.",
      tone: player ? (won ? "win" : "loss") : "neutral",
      settling,
    };
  }
  const tone = player ? resultTone(result, m, myPk) : "neutral";
  if (tone !== "neutral")
    return {
      title: tone === "win" ? "You win!" : "You lose",
      message: /by timeout|ran out of time|timer ran out/i.test(result)
        ? tone === "win"
          ? "Your opponent ran out of time."
          : "You ran out of time."
        : tone === "win"
          ? "You connected four."
          : "Your opponent connected four.",
      tone,
      settling,
    };
  if (/both connected four/i.test(result))
    return draw("You both connected four in the same round.");
  if (/draw|split|stalled/i.test(result))
    return draw(
      /time|stalled/i.test(result) ? "The game reached its time limit." : "The board is full.",
    );
  if (/called off|dissolved|left before/i.test(result))
    return {
      title: "Game cancelled",
      message: "This game ended before the first move.",
      tone,
      settling,
    };
  if (!player && /connected four|winner took/i.test(result)) {
    const color = p1 ? (m.p1Color ?? "red") : m.p1Color === "blue" ? "red" : "blue";
    return {
      title: p1 || p2 ? `${color === "red" ? "Red" : "Blue"} wins!` : "Game over",
      message: "Four in a row.",
      tone,
      settling,
    };
  }
  return {
    title: "Game over",
    message: /pot|stake|payout|balance|refund|fee/i.test(result)
      ? "The game has ended."
      : result
          .replace(
            /\s*[—–]\s*(\p{Ll})?/gu,
            (_dash, next: string | undefined) => `. ${next?.toUpperCase() ?? ""}`,
          )
          .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
          .trim(),
    tone,
    settling,
  };
}

/** Classify personal outcomes without treating "no winner" as a defeat. */
export function resultTone(result: string, match?: Match, myPk?: string): ResultTone {
  if (/you win/i.test(result)) return "win";
  if (result.includes("winner took the pot") && match && myPk) {
    const winner = match.simul?.pendingWin;
    if (winner) return (winner === 1 ? match.state.p1 : match.state.p2) === myPk ? "win" : "loss";
  }
  if (/your opponent (?:connected four|claimed the (?:win|pot))/i.test(result)) return "loss";
  return "neutral";
}
