import { useEffect, useState } from "react";
import type { ResultTone } from "../lib";

interface Props {
  result: string;
  tone: ResultTone;
  busy: boolean;
  onPlayAgain: () => void;
  onExit: () => void;
  /** Hide the card to inspect the final board. */
  onDismiss: () => void;
}

/**
 * The verdict, delivered over the finished board: a dimmed backdrop and a
 * card naming the outcome. Held back for a beat after the result lands so
 * the final disc and the glowing line get their moment first.
 */
export const ResultOverlay = ({ result, tone, busy, onPlayAgain, onExit, onDismiss }: Props) => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 1100);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;

  const title = tone === "win" ? "You win!" : tone === "loss" ? "You lose" : "Game over";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="overlay-fade fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    >
      <div className="overlay-pop card relative w-full max-w-100 bg-panel px-6 py-6 text-center">
        <h2
          className={`mb-2 text-3xl font-bold ${
            tone === "win" ? "text-ok" : tone === "loss" ? "text-red" : ""
          }`}
        >
          {title}
        </h2>
        <p className="mb-5 text-dim">{result}</p>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button className="btn" disabled={busy} onClick={onPlayAgain}>
            Play again
          </button>
          <button className="btn btn-muted" disabled={busy} onClick={onExit}>
            Back to start
          </button>
          <button className="btn btn-ghost" onClick={onDismiss}>
            View board
          </button>
        </div>
      </div>
    </div>
  );
};
