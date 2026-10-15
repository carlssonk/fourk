import { fmtKas, isStaked, type Match } from "@shared/lib/match";
import { gameEnd } from "@shared/lib/result";
import { matchWallet } from "@shared/state";
import type { MatchGlance } from "../hooks";

const GLANCE_LABEL: Record<MatchGlance, string> = {
  waiting: "Waiting for an opponent",
  "your-turn": "Your turn!",
  "their-turn": "Opponent's turn",
  finished: "Finished",
  changed: "Updated while you were away",
};

interface Props {
  matches: Match[];
  glances: Record<string, MatchGlance>;
  /** Matches whose payout the player can send from here. */
  collectable: Record<string, boolean>;
  busy: boolean;
  onOpen: (m: Match) => void;
  onCollect: (m: Match) => void;
}

/** Compact two-line match cards; the parent owns width and placement. */
export const MatchList = ({ matches, glances, collectable, busy, onOpen, onCollect }: Props) => {
  if (!matches.length) return null;
  return (
    <div className="text-left">
      <h3 className="mb-2.5 text-base font-semibold text-dim">Your matches</h3>
      {matches.map((m) => {
        const glance = glances[m.covenantId];
        const ending = gameEnd(m, matchWallet(m)?.myPk ?? "");
        const urgent = !ending && glance === "your-turn";
        return (
          <div
            key={m.covenantId}
            className={`card mb-2 flex items-center ${urgent ? "border-accent" : ""}`}
          >
            <button
              className="min-w-0 flex-1 cursor-pointer px-3.5 py-2.5 text-left disabled:cursor-default disabled:opacity-45"
              disabled={busy}
              onClick={() => onOpen(m)}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm text-dim">#{m.covenantId.slice(0, 8)}</span>
                {/* Stakes are the exception worth flagging; an unstaked game
                 * is just a game, so it carries no label at all. */}
                {isStaked(m) && (
                  <span className="text-sm text-accent">
                    <span className="mr-1.5 rounded-sm border border-accent px-1 text-[10px] font-semibold uppercase">
                      staked
                    </span>
                    {fmtKas(m.value)} KAS
                  </span>
                )}
              </span>
              <span className={`mt-0.5 block text-sm ${urgent ? "text-accent" : "text-dim"}`}>
                {ending
                  ? `${ending.title}${isStaked(m) && ending.settling ? " · Settlement pending" : ""}`
                  : glance
                    ? GLANCE_LABEL[glance]
                    : "checking…"}
              </span>
            </button>
            {collectable[m.covenantId] && (
              <button
                className="btn mr-2.5 shrink-0 px-3 py-1 text-sm"
                disabled={busy}
                onClick={() => onCollect(m)}
              >
                Collect
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
