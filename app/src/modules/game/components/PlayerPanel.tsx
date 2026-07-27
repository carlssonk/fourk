import { Avatar } from "@shared/components/Avatar";
import { codeFromPubkey } from "@shared/lib/avatar";
import { ZERO_PK } from "@shared/lib/game";
import type { PlayerProfile } from "@shared/lib/match";

interface Props {
  pk: string;
  profile?: PlayerProfile;
  color: "red" | "blue";
  isMe: boolean;
  /** This player is on the move. */
  active: boolean;
  /** Countdown until they forfeit, shown while active (null in the lobby —
   * the covenant runs no clock before the first disc). */
  clock: string | null;
}

/**
 * One player's identity beside the board: avatar, name, disc colour, and
 * their move clock. Players without a received profile still get a face
 * (genes derived from their pubkey) and a pseudonym; an empty seat gets a
 * placeholder.
 */
export const PlayerPanel = ({ pk, profile, color, isMe, active, clock }: Props) => {
  const open = pk === ZERO_PK;
  const name = open ? "Open seat" : profile?.name || `anon-${pk.slice(0, 4)}`;
  const urgent = clock !== null && parseInt(clock, 10) < 5;

  return (
    <div className={`card w-28 shrink-0 px-2 py-3 text-center ${active ? "border-accent" : ""}`}>
      {open ? (
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-line text-2xl text-dim">
          ?
        </div>
      ) : (
        <Avatar code={profile?.avatar ?? codeFromPubkey(pk)} size={64} className="mx-auto" />
      )}
      <div
        className={`mt-1.5 truncate text-sm font-semibold ${open ? "text-dim" : ""}`}
        title={name}
      >
        <span className={color === "red" ? "text-red" : "text-blue"}>●</span> {name}
      </div>
      <div className="h-4 text-xs text-dim">{isMe ? "you" : " "}</div>
      <div
        className={`mt-0.5 h-5 font-mono text-sm ${
          urgent ? "text-red" : active ? "text-accent" : "text-dim"
        }`}
      >
        {active ? (clock ?? " ") : " "}
      </div>
    </div>
  );
};
