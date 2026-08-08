import { useAtomValue, useSetAtom } from "jotai";
import { STAKE_PRESETS, fmtDaaDuration, fmtKas } from "@shared/lib/match";
import { MODES, MODE_LIST } from "@shared/modes/registry";
import {
  FEE_MARGIN,
  accountPanelAtom,
  balanceAtom,
  gameModeAtom,
  hasOwnedAccount,
  moveTimeoutAtom,
  saveGameMode,
  saveMoveTimeout,
  saveStake,
  stakeAtom,
} from "@shared/state";

/** Per-move forfeit clock presets, in DAA blocks (~600/min on testnet-10). */
const MOVE_PRESETS = [600, 3000, 9000, 36_000, 864_000];

export const Chip = ({
  on = false,
  onClick,
  disabled = false,
  title = "coming soon",
  children,
}: {
  on?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip while disabled. */
  title?: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    title={disabled ? title : undefined}
    className={`rounded-md border px-2.5 py-1 ${
      disabled
        ? "cursor-default border-line text-dim opacity-45"
        : `cursor-pointer ${on ? "border-accent" : "border-line text-dim"}`
    }`}
  >
    {children}
  </button>
);

const Group = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="mt-3 first:mt-0">
    <div className="mb-1 text-dim">{label}</div>
    <div className="flex flex-wrap gap-1.5">{children}</div>
  </div>
);

/**
 * What kind of game to start: mode, clock, stake. Deliberately just these
 * three — they're the settings that survive matchmaking, so the same
 * choices drive Quick Match and Private Game alike. Anything that can't be
 * a matchmaking bucket (disc colour) lives in the profile instead.
 */
export const MatchSettings = () => {
  const gameMode = useAtomValue(gameModeAtom);
  const moveTimeout = useAtomValue(moveTimeoutAtom);
  const stake = useAtomValue(stakeAtom);
  const balance = useAtomValue(balanceAtom);
  const openAccount = useSetAtom(accountPanelAtom);
  const owned = hasOwnedAccount();

  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <Group label="Game mode">
        {MODE_LIST.map((m) => (
          <Chip
            key={m.meta.key}
            on={gameMode === m.meta.key}
            onClick={() => saveGameMode(m.meta.key)}
          >
            {m.meta.label}
          </Chip>
        ))}
      </Group>
      <p className="mt-1.5 text-xs text-dim">{MODES[gameMode].meta.blurb}</p>

      <Group label="Move timer">
        {MOVE_PRESETS.map((daa) => (
          <Chip key={daa} on={moveTimeout === daa} onClick={() => saveMoveTimeout(daa)}>
            {fmtDaaDuration(daa)}
          </Chip>
        ))}
      </Group>

      {/* Guests get one quiet line instead of the picker: no amounts, no
       * balance — free mode keeps money off the screen entirely. */}
      {owned ? (
        <>
          <Group label="Stake">
            {STAKE_PRESETS.map((s) => {
              // Only once the balance is actually known — a null balance is
              // still loading, and greying the row out then reads as
              // "you're broke" to someone who isn't.
              const short = s > 0n && balance !== null && balance < s + FEE_MARGIN;
              return (
                <Chip
                  key={String(s)}
                  on={stake === s}
                  disabled={short}
                  title="add funds first"
                  onClick={() => saveStake(s)}
                >
                  {s === 0n ? "Free" : `${fmtKas(s)} KAS`}
                </Chip>
              );
            })}
          </Group>
          {stake > 0n ? (
            <p className="mt-1.5 text-xs text-dim">
              Both players put in the stake — winner takes the pot, paid from your balance.
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-dim">
              Free games are on the house.{" "}
              <button className="cursor-pointer underline" onClick={() => openAccount("add-funds")}>
                Add funds
              </button>{" "}
              to play for a stake.
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs text-dim">
          Want to play for stakes?{" "}
          <button className="cursor-pointer underline" onClick={() => openAccount("get-started")}>
            Create an account
          </button>
          .
        </p>
      )}
    </div>
  );
};
