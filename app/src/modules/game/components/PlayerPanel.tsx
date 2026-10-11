import { Avatar } from "@shared/components/Avatar";
import { codeFromPubkey } from "@shared/lib/avatar";
import { ZERO_PK } from "@shared/lib/game";
import type { PlayerProfile } from "@shared/lib/match";
import type { MoveClock } from "../hooks/useMoveClock";
import { MoveTimer } from "./MoveTimer";

interface Props {
  pk: string;
  profile?: PlayerProfile;
  color: "red" | "blue";
  isMe: boolean;
  clock?: MoveClock | null;
  /** Fourk mode: this seat's disc lands underneath if both players pick the
   * same column this round (priority alternates every round). */
  collisionPriority?: boolean;
  align?: "start" | "end";
}

/**
 * One player's identity: avatar, name, and disc colour. The accent border
 * always identifies your own seat, independently of whose turn it is.
 * Names use their natural height, capped at two lines. Paired cards stay aligned.
 * Players without a received profile still get a face (genes derived from
 * their pubkey) and a pseudonym; an empty seat gets a placeholder.
 */
export const PlayerPanel = ({
  pk,
  profile,
  color,
  isMe,
  clock,
  collisionPriority = false,
  align = "start",
}: Props) => {
  const open = pk === ZERO_PK;
  const name = open ? "Open seat" : profile?.name || `anon-${pk.slice(0, 4)}`;

  return (
    <div
      role="group"
      aria-label={open ? "Open seat" : `${isMe ? "Your player" : "Player"}: ${name}, ${color}`}
      className={`card relative mb-6 flex w-40 max-w-full flex-col items-center gap-0.5 self-stretch px-1.5 pt-1 pb-2.5 ${align === "end" ? "justify-self-end" : "justify-self-start"} ${isMe && !open ? "border-accent" : "border-line"}`}
    >
      {/* Keep the priority badge clear of the avatar and name. */}
      {collisionPriority && (
        <span
          title={`If both players pick the same column this round, ${isMe ? "your" : `${name}'s`} disc lands underneath. Priority alternates every round.`}
          className="absolute top-full right-0 mt-1 cursor-help rounded-sm px-1 text-[10px] leading-4 font-semibold text-accent"
        >
          ▼ lands 1st
        </span>
      )}
      <div className="flex h-8 shrink-0 items-center justify-center gap-2">
        {open ? (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-base text-dim">
            ?
          </div>
        ) : (
          <Avatar code={profile?.avatar ?? codeFromPubkey(pk)} size={32} className="shrink-0" />
        )}
      </div>
      <div className="w-full min-w-0 text-center">
        <div
          className={`line-clamp-2 text-sm leading-4 font-semibold break-all ${open ? "text-dim" : ""}`}
          title={name}
        >
          {/* No dot on an empty seat — nobody owns the colour yet, and the
           * dot's width is what ellipsized "Open seat". */}
          {open ? (
            name
          ) : (
            <>
              <span className={color === "red" ? "text-red" : "text-blue"}>●</span> {name}
            </>
          )}
        </div>
      </div>
      {!open && clock && <MoveTimer clock={clock} />}
    </div>
  );
};
