import { useEffect, useState } from "react";
import { Dialog } from "@shared/components/Dialog";
import type { ResultTone } from "../lib";

interface Props {
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

/** A shower of coins past a winning verdict — the game's own discs, falling
 * once and gone. The scatter is derived from the index rather than drawn at
 * random so a re-render never restarts it somewhere new. */
const Coins = () => (
  <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
    {Array.from({ length: 18 }, (_, i) => {
      const size = 9 + ((i * 5) % 4) * 3;
      const spin = (360 + ((i * 11) % 5) * 90) * (i % 2 ? 1 : -1);
      return (
        <span
          key={i}
          className={`coin-fall absolute top-0 rounded-full ${i % 2 ? "disc-red" : "disc-blue"}`}
          style={{
            left: `${(i * 37 + 9) % 100}%`,
            width: size,
            height: size,
            animationDelay: `${((i * 13) % 11) / 8}s`,
            animationDuration: `${2.6 + ((i * 7) % 5) * 0.35}s`,
            ["--spin" as string]: `${spin}deg`,
          }}
        />
      );
    })}
  </div>
);

/**
 * The verdict, delivered over the finished board: the page dims away and a
 * card rises in the colour of the outcome — green for a win (with coins
 * raining past it), red for a loss, neutral for anything undecided. Held
 * back for a beat after the result lands so the final disc and the glowing
 * line get their moment first.
 */
export const ResultOverlay = ({
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

  const title = tone === "win" ? "You win!" : tone === "loss" ? "You lose" : "Game over";

  return (
    <Dialog
      title={title}
      headline
      tone={tone === "win" ? "win" : tone === "loss" ? "loss" : "neutral"}
      // Wide enough to keep the three endings on one row — a lone wrapped
      // button reads as an afterthought.
      width="max-w-115"
      className="text-center"
      // Escape and a click beside the card do what "View board" does — the
      // reflex dismissal shouldn't be a dead end here, the board is right
      // behind it.
      onDismiss={onDismiss}
      {...(tone === "win" && { behind: <Coins /> })}
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
        <button className="btn btn-ghost" onClick={onDismiss}>
          View board
        </button>
      </div>
    </Dialog>
  );
};
