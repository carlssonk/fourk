import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@shared/components/Dialog";
import { fmtDaaDuration } from "@shared/lib/match";
import { isSoundEnabled, setSoundEnabled, subscribeToSound } from "@shared/lib/sound";
import type { ModeMeta } from "@shared/modes/types";

interface Props {
  mode: ModeMeta;
  moveTimeout: number;
  busy: boolean;
  ended: boolean;
  capTime: string | null;
  staked: boolean;
  onHome: () => void;
}

export const GameHeader = ({ mode, moveTimeout, busy, ended, capTime, staked, onHome }: Props) => {
  const [help, setHelp] = useState(false);
  const helpButton = useRef<HTMLButtonElement>(null);
  const helpWasOpen = useRef(false);
  const sound = useSyncExternalStore(subscribeToSound, isSoundEnabled);
  const capHelp = staked
    ? "Estimated time until the game limit. If the game is unfinished, the pot splits evenly and both stakes return. The network confirms when the limit is reached."
    : "Estimated time until the game limit. If the game is unfinished, it ends as a draw. The network confirms when the limit is reached.";
  useEffect(() => {
    if (!help && helpWasOpen.current && !document.querySelector("dialog[open]")) {
      helpButton.current?.focus();
    }
    helpWasOpen.current = help;
  }, [help]);
  useEffect(() => {
    if (ended) setHelp(false);
  }, [ended]);

  return (
    <>
      <header className="mb-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b border-line pb-2">
        <div className="col-start-1 row-start-1 flex min-w-0 items-baseline gap-3">
          <span className="shrink-0 font-display text-2xl font-extrabold tracking-tight text-accent">
            fourk<span className="text-sm font-medium tracking-normal text-dim">.io</span>
          </span>
          <span className="hidden text-sm whitespace-nowrap text-dim md:inline">
            {mode.label} · {fmtDaaDuration(moveTimeout)} per {mode.moveNoun}
          </span>
        </div>
        <div className="col-start-2 row-start-1 text-center">
          {!ended && capTime !== null && (
            <div title={capHelp}>
              <span className="block text-[10px] leading-4 text-dim">Game limit</span>
              <span
                role="timer"
                aria-label="Game time remaining"
                aria-live="off"
                className="block font-mono text-sm leading-5 tabular-nums"
              >
                {capTime}
              </span>
            </div>
          )}
        </div>
        <div className="contents md:col-start-3 md:row-start-1 md:flex md:items-center md:gap-1 md:justify-self-end">
          <span className="col-span-2 col-start-1 row-start-2 justify-self-start text-xs text-dim sm:text-sm md:hidden">
            {mode.label} · {fmtDaaDuration(moveTimeout)} per {mode.moveNoun}
          </span>
          <div className="col-span-2 col-start-2 row-start-2 flex shrink-0 items-center gap-1 justify-self-end">
            <button
              ref={helpButton}
              type="button"
              className="min-h-10 cursor-pointer rounded-md px-2 text-sm text-dim hover:bg-white/5 hover:text-ink"
              onClick={() => setHelp(true)}
            >
              How to play
            </button>
            <button
              type="button"
              aria-label="Sound"
              aria-pressed={sound}
              title={sound ? "Mute sounds" : "Enable sounds"}
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim hover:bg-white/5 hover:text-ink"
              onClick={() => setSoundEnabled(!sound)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                {sound ? (
                  <>
                    <path d="M15 8a6 6 0 0 1 0 8" />
                    <path d="M18 5a10 10 0 0 1 0 14" />
                  </>
                ) : (
                  <path d="m16 9 6 6m0-6-6 6" />
                )}
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="btn btn-muted col-start-3 row-start-1 inline-flex min-h-10 items-center gap-1.5 justify-self-end px-3 text-sm"
            disabled={busy}
            title={
              ended ? "Return home" : "Return home without cancelling. The game is not paused."
            }
            onClick={onHome}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m12 5-7 7 7 7M5 12h14" />
            </svg>
            Home
          </button>
        </div>
      </header>
      {help && (
        <Dialog
          title={`How to play ${mode.label}`}
          onDismiss={() => setHelp(false)}
          className="space-y-4 text-sm"
        >
          <p>Connect four of your discs horizontally, vertically, or diagonally to win.</p>
          {mode.key !== "classic" ? (
            <ol className="list-decimal space-y-2 pl-5 text-dim">
              <li>
                Both players choose a column in secret. Your choice stays hidden until both players
                have picked.
              </li>
              {mode.key === "fourk2" && (
                <li>
                  The first pick of the game starts the other player's timer. If it goes unanswered,
                  the game is called off.
                </li>
              )}
              <li>
                The discs drop together. If you choose the same column, the player marked "lands
                1st" goes underneath. This alternates each round.
              </li>
              <li>If both players connect four in the same round, the game is a draw.</li>
            </ol>
          ) : (
            <p className="text-dim">
              Take turns choosing a column. Your disc drops into its lowest empty space. The first
              player to connect four wins.
            </p>
          )}
          <p className="text-dim">
            A full board without a winner is a draw. You cannot choose a full column.
          </p>
          <div className="border-t border-line pt-3">
            <h3 className="mb-1 font-semibold">Move timer</h3>
            <p className="text-dim">
              {mode.key === "fourk2"
                ? `Each round, both players have ${fmtDaaDuration(moveTimeout)} to pick, counted from the same moment. A pick counts once the network confirms it. If only your opponent picks in time, they can claim the win; if neither of you does, the round is a draw. The first round is the exception: a missing pick there calls the game off instead.`
                : `This game allows ${fmtDaaDuration(moveTimeout)} per ${mode.moveNoun}. If you run out of time, your opponent can claim the win.`}{" "}
              Opening this help does not pause the game.
            </p>
          </div>
          {capTime !== null && (
            <div className="border-t border-line pt-3">
              <h3 className="mb-1 font-semibold">Game limit</h3>
              <p className="text-dim">{capHelp}</p>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
};
