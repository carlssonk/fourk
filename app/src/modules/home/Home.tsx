import { useAtomValue } from "jotai";
import { Avatar } from "@shared/components/Avatar";
import { fmtDaaDuration, fmtKas } from "@shared/lib/match";
import { MODES, MODE_LIST, modeOf } from "@shared/modes/registry";
import {
  busyAtom,
  clearInvite,
  gameCapAtom,
  gameModeAtom,
  hostColorAtom,
  matchesAtom,
  moveTimeoutAtom,
  newGame,
  pendingInviteAtom,
  saveGameCap,
  saveGameMode,
  saveHostColor,
  saveMoveTimeout,
  showMatch,
  takeSeat,
} from "@shared/state";
import { BoardBackdrop, MatchList, PlayerSetup } from "./components";
import { useMatchGlances } from "./hooks";

/** Host-side match settings, in DAA blocks (~600/min on testnet-10). */
const MOVE_PRESETS = [600, 3000, 9000, 36_000, 864_000];
const CAP_PRESETS = [0, 36_000, 216_000, 864_000, 6_048_000];

const Chip = ({
  on = false,
  onClick,
  disabled = false,
  children,
}: {
  on?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    title={disabled ? "coming soon" : undefined}
    className={`rounded-md border px-2.5 py-1 ${
      disabled
        ? "cursor-default border-line text-dim opacity-45"
        : `cursor-pointer ${on ? "border-accent" : "border-line text-dim"}`
    }`}
  >
    {children}
  </button>
);

export const Home = () => {
  const pendingInvite = useAtomValue(pendingInviteAtom);
  const matches = useAtomValue(matchesAtom);
  const busy = useAtomValue(busyAtom);
  const hostColor = useAtomValue(hostColorAtom);
  const moveTimeout = useAtomValue(moveTimeoutAtom);
  const gameCap = useAtomValue(gameCapAtom);
  const gameMode = useAtomValue(gameModeAtom);
  const glances = useMatchGlances();

  if (pendingInvite) {
    const host = pendingInvite.profiles?.p1;
    const myColor = pendingInvite.p1Color === "blue" ? "red" : "blue";
    const inviteMeta = modeOf(pendingInvite).meta;
    return (
      <div className="pt-12 pb-8 text-center">
        <BoardBackdrop />
        {host && <Avatar code={host.avatar} size={72} className="mx-auto mb-1" />}
        <h2 className="mb-1.5 text-2xl font-bold">
          {host?.name ? `${host.name} invited you to a game!` : "You've been invited to a game!"}
        </h2>
        <p className="text-sm text-dim">
          {inviteMeta.inviteBlurb}
          <b className={myColor === "red" ? "text-red" : "text-blue"}>{myColor} ●</b>.
        </p>
        <p className="mt-1 text-xs text-dim">
          {fmtKas(pendingInvite.state.stake)} KAS stake each (free mode funds yours) ·{" "}
          {fmtDaaDuration(pendingInvite.state.moveTimeout)} per {inviteMeta.moveNoun}
          {pendingInvite.state.deadline > 0 && " · total game time capped"}
        </p>
        <PlayerSetup actionLabel="Join" busy={busy} onSubmit={() => takeSeat(pendingInvite)} />
        <button className="btn" disabled={busy} onClick={clearInvite}>
          Not now
        </button>
      </div>
    );
  }

  return (
    <div className="pt-12 pb-8 text-center">
      <BoardBackdrop />
      <h2 className="mb-1.5 text-2xl font-bold">FOURK</h2>
      <p className="text-sm text-dim">a multiplayer connect four game.</p>
      <div className="relative mx-auto w-fit max-w-full">
        <div className="max-w-full">
          <PlayerSetup
            actionLabel="Private Game"
            headlineLabel="Quick Match"
            busy={busy}
            onSubmit={newGame}
            modes={
              <div className="mt-4 border-t border-line pt-4 text-sm">
                <div className="mb-1 text-dim">Game mode</div>
                <div className="flex flex-wrap gap-1.5">
                  {MODE_LIST.map((m) => (
                    <Chip
                      key={m.meta.key}
                      on={gameMode === m.meta.key}
                      onClick={() => saveGameMode(m.meta.key)}
                    >
                      {m.meta.label}
                    </Chip>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-dim">{MODES[gameMode].meta.blurb}</p>
              </div>
            }
          >
            <h3 className="mb-3 text-sm font-semibold text-dim">Match settings</h3>
            <div className="text-sm">
              <div className="mb-1 text-dim">Play as</div>
              <div className="flex flex-wrap gap-1.5">
                {(["blue", "red"] as const).map((c) => (
                  <Chip key={c} on={hostColor === c} onClick={() => saveHostColor(c)}>
                    <span className={c === "red" ? "text-red" : "text-blue"}>●</span> {c}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="mt-3 text-sm">
              <div className="mb-1 text-dim">Move timer</div>
              <div className="flex flex-wrap gap-1.5">
                {MOVE_PRESETS.map((daa) => (
                  <Chip key={daa} on={moveTimeout === daa} onClick={() => saveMoveTimeout(daa)}>
                    {fmtDaaDuration(daa)}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="mt-3 text-sm">
              <div className="mb-1 text-dim">Game limit</div>
              <div className="flex flex-wrap gap-1.5">
                {CAP_PRESETS.map((daa) => (
                  <Chip key={daa} on={gameCap === daa} onClick={() => saveGameCap(daa)}>
                    {daa === 0 ? "none" : fmtDaaDuration(daa)}
                  </Chip>
                ))}
              </div>
            </div>
          </PlayerSetup>
        </div>
        {/* Hung off the create column's left edge on wide screens so the
         * create flow stays on the page's center axis; stacked below it
         * otherwise. */}
        {matches.length > 0 && (
          <aside className="mx-auto mt-10 w-full max-w-115 xl:absolute xl:top-5 xl:right-full xl:mt-0 xl:mr-6 xl:w-64">
            <MatchList matches={matches} glances={glances} busy={busy} onOpen={showMatch} />
          </aside>
        )}
      </div>
    </div>
  );
};
