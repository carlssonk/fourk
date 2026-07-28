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
 * One player's identity in the top bar: avatar, name, disc colour, and
 * their move clock, laid out as a slim horizontal chip so the board below
 * keeps the vertical space. Players without a received profile still get a
 * face (genes derived from their pubkey) and a pseudonym; an empty seat
 * gets a placeholder.
 */
export const PlayerPanel = ({ pk, profile, color, isMe, active, clock }: Props) => {
  const open = pk === ZERO_PK;
  const name = open ? "Open seat" : profile?.name || `anon-${pk.slice(0, 4)}`;
  const urgent = clock !== null && parseInt(clock, 10) < 5;

  return (
    <div
      className={`card flex w-40 shrink-0 items-center gap-2.5 px-3 py-2 ${active ? "border-accent" : ""}`}
    >
      {open ? (
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-lg text-dim">
          ?
        </div>
      ) : (
        <Avatar code={profile?.avatar ?? codeFromPubkey(pk)} size={44} className="shrink-0" />
      )}
      <div className="min-w-0 text-left">
        <div className={`truncate text-sm font-semibold ${open ? "text-dim" : ""}`} title={name}>
          <span className={color === "red" ? "text-red" : "text-blue"}>●</span> {name}
        </div>
        <div
          className={`h-5 font-mono text-sm ${
            urgent ? "text-red" : active ? "text-accent" : "text-dim"
          }`}
        >
          {active && clock !== null ? clock : isMe ? "you" : " "}
        </div>
      </div>
    </div>
  );
};
