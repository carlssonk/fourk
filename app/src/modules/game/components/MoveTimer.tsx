import type { MoveClock } from "../hooks/useMoveClock";

/** Shown in each seat that still needs to act, outside live announcements. */
export const MoveTimer = ({ clock }: { clock: MoveClock }) => {
  if (clock.text === null) return null;
  const urgent = clock.secondsLeft !== null && clock.secondsLeft <= 5;
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-white/10"
      >
        <span
          data-testid="move-time-fill"
          className={`block h-full origin-left ${urgent ? "bg-red" : "bg-accent"}`}
          style={{ transform: `scaleX(${clock.fractionRemaining})` }}
        />
      </span>
      <span
        role="timer"
        aria-label="Move time remaining"
        aria-live="off"
        title="Time remaining to act"
        className={`absolute top-full left-0 mt-1 font-mono text-xs leading-4 tabular-nums ${
          urgent ? "text-red" : "text-dim"
        }`}
      >
        {clock.text}
      </span>
    </>
  );
};
