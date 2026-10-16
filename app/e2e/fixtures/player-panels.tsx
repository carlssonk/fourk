import { createRoot } from "react-dom/client";
import { PlayerPanel } from "../../src/modules/game/components/PlayerPanel";

/** Exercise name sizing without creating a blockchain match. */
export function mountPlayerPanels(
  secondsLeft: number | null = 59,
  timedSeats: "first" | "second" | "both" = "first",
  durationSeconds = 60,
) {
  const clock = {
    text:
      secondsLeft === null
        ? null
        : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`,
    secondsLeft,
    expired: secondsLeft === 0,
    fractionRemaining: Math.max(0, Math.min(1, (secondsLeft ?? 0) / durationSeconds)),
  };
  // This covers Home, whose scrollbar gutter (styles.css) would narrow it;
  // the game screen it stands in for has none.
  document.documentElement.style.scrollbarGutter = "auto";
  const container = document.createElement("div");
  container.className = "fixed inset-0 z-50 overflow-auto bg-bg p-4";
  document.body.append(container);
  createRoot(container).render(
    <div className="mx-auto max-w-262 space-y-8">
      {["Al", "FriendlyPlayer", "AReallyLongUnbrokenPlayerName"].map((name) => (
        <div
          key={name}
          data-testid={`players-${name}`}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]"
        >
          <PlayerPanel
            pk={"11".repeat(32)}
            profile={{ name, avatar: "0123456789abcdef" }}
            color="red"
            isMe
            clock={timedSeats !== "second" ? clock : null}
            collisionPriority
          />
          <div
            data-testid="turn-status"
            className="order-3 col-span-2 flex min-w-0 flex-wrap items-center justify-center gap-3 text-center sm:order-0 sm:col-span-1"
          >
            <span role="status">Your turn</span>
          </div>
          <PlayerPanel
            pk={"22".repeat(32)}
            profile={{ name: "Bo", avatar: "0123456789abcdef" }}
            color="blue"
            isMe={false}
            clock={timedSeats !== "first" ? clock : null}
            align="end"
          />
        </div>
      ))}
    </div>,
  );
}
