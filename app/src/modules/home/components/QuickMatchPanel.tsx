import { useEffect, useState } from "react";
import { DiscLoader } from "@shared/components/DiscLoader";
import { fmtDaaDuration } from "@shared/lib/match";
import { QUICK_MATCH_MOVE_TIMEOUT } from "@shared/lib/quickMatch";
import type { QuickMatchStatus } from "@shared/state";

/** After this long in the queue, offer the private-game way out. */
const LONELY_MS = 60_000;

interface Props {
  status: Exclude<QuickMatchStatus, { phase: "idle" }>;
  busy: boolean;
  onCancel: () => void;
  onPrivateGame: () => void;
}

const fmtElapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Home while Quick Match runs: in the queue, or paired and setting up. */
export const QuickMatchPanel = ({ status, busy, onCancel, onPrivateGame }: Props) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const waited = status.phase === "searching" ? Math.max(0, now - status.since) : 0;
  const lonely = waited >= LONELY_MS;

  return (
    <div className="card mx-auto my-5 w-115 max-w-full p-6 text-center">
      <DiscLoader className="mb-4" />
      {status.phase === "searching" ? (
        <>
          <h3 className="text-lg font-semibold">Looking for an opponent</h3>
          <p className="text-sm text-dim tabular-nums">{fmtElapsed(waited)}</p>
          {lonely && (
            <p className="mt-3 text-sm text-dim">
              No one's around right now. Keep waiting, or start a private game and send the link.
            </p>
          )}
        </>
      ) : (
        <h3 className="text-lg font-semibold">Found an opponent. Setting up the game…</h3>
      )}
      <p className="mt-1 text-xs text-dim">
        Free game, {fmtDaaDuration(QUICK_MATCH_MOVE_TIMEOUT)} per pick.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2.5">
        <button className="btn btn-muted" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {lonely && (
          <button className="btn btn-ghost" disabled={busy} onClick={onPrivateGame}>
            Start a private game
          </button>
        )}
      </div>
    </div>
  );
};
