import { useEffect, useState } from "react";
import { Dialog } from "@shared/components/Dialog";
import type { ResultTone } from "../lib";

interface Props {
  title: string;
  result: string;
  /** Staked games: where the money went, in balance terms. */
  pot?: string | undefined;
  tone: ResultTone;
  busy: boolean;
  onPlayAgain: () => void;
  onExit: () => void;
  /** Hide the card to inspect the final board. */
  onDismiss: () => void;
}

/**
 * The verdict, delivered over the finished board: the page dims away and a
 * card rises in the colour of the outcome — green for a win, red for a
 * loss, neutral for anything undecided. Held back for a beat after the
 * result lands so the final disc and the winning line get their moment
 * first.
 */
export const ResultOverlay = ({
  title,
  result,
  pot,
  tone,
  busy,
  onPlayAgain,
  onExit,
  onDismiss,
}: Props) => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 1100);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;

  return (
    <Dialog
      title={title}
      headline
      tone={tone === "win" ? "win" : tone === "loss" ? "loss" : "neutral"}
      width="max-w-115"
      className="text-center"
      // Escape and a click beside the card reveal the finished board.
      onDismiss={onDismiss}
    >
      <p className={`text-dim ${pot ? "mb-3" : "mb-5"}`}>{result}</p>
      {pot && <p className="well mb-5 px-3 py-2 font-semibold text-accent">{pot}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <button className="btn" disabled={busy} onClick={onPlayAgain}>
          Play again
        </button>
        <button className="btn btn-muted" disabled={busy} onClick={onExit}>
          Back to start
        </button>
      </div>
    </Dialog>
  );
};
