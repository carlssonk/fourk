import { Dialog } from "@shared/components/Dialog";
import { fmtDaaDuration } from "@shared/lib/match";
import type { ModeMeta } from "@shared/modes/types";

/** What the whole-game limit does, for its tooltip and the rules. */
export const capHelpText = (staked: boolean): string =>
  staked
    ? "Estimated time until the game limit. If the game is unfinished, the pot splits evenly and both stakes return. The network confirms when the limit is reached."
    : "Estimated time until the game limit. If the game is unfinished, it ends as a draw. The network confirms when the limit is reached.";

/** A mode's rules and clocks, from the game header and the invite screen. */
export const HowToPlayDialog = ({
  mode,
  moveTimeout,
  staked,
  showCap,
  inGame = false,
  onDismiss,
}: {
  mode: ModeMeta;
  moveTimeout: number;
  staked: boolean;
  showCap: boolean;
  /** Opened from a running game, not the invite screen before joining. */
  inGame?: boolean;
  onDismiss: () => void;
}) => (
  <Dialog title={`How to play ${mode.label}`} onDismiss={onDismiss} className="space-y-4 text-sm">
    <p>Connect four of your discs horizontally, vertically, or diagonally to win.</p>
    {mode.key !== "classic" ? (
      <ol className="list-decimal space-y-2 pl-5 text-dim">
        <li>
          Both players choose a column in secret. Your choice stays hidden until both players have
          picked.
        </li>
        {mode.key === "fourk2" && (
          <li>
            The first pick of the game starts the other player's timer. If it goes unanswered, the
            game is called off.
          </li>
        )}
        <li>
          The discs drop together. If you choose the same column, the player marked "lands 1st" goes
          underneath. This alternates each round.
        </li>
        <li>If both players connect four in the same round, the game is a draw.</li>
      </ol>
    ) : (
      <p className="text-dim">
        Take turns choosing a column. Your disc drops into its lowest empty space. The first player
        to connect four wins.
      </p>
    )}
    <p className="text-dim">
      A full board without a winner is a draw. You cannot choose a full column.
    </p>
    <div className="border-t border-line pt-3">
      <h3 className="mb-1 font-semibold">Move timer</h3>
      <p className="text-dim">
        {mode.key === "fourk2"
          ? `Each round, both players have ${fmtDaaDuration(moveTimeout)} to pick, counted from the same moment. A pick counts once the network confirms it. If only your opponent picks in time, they can claim the win; if neither of you does, the game ends in a draw. The first round is the exception: a missing pick there calls the game off instead.`
          : `This game allows ${fmtDaaDuration(moveTimeout)} per ${mode.moveNoun}. If you run out of time, your opponent can claim the win.`}
        {inGame && " Opening this help does not pause the game."}
      </p>
    </div>
    {showCap && (
      <div className="border-t border-line pt-3">
        <h3 className="mb-1 font-semibold">Game limit</h3>
        <p className="text-dim">{capHelpText(staked)}</p>
      </div>
    )}
  </Dialog>
);
