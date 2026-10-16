import { useAtomValue, useSetAtom } from "jotai";
import { InfoTip } from "@shared/components/InfoTip";
import { STAKE_PRESETS, fmtDaaDuration, fmtKas } from "@shared/lib/match";
import { MODES, MODE_LIST } from "@shared/modes/registry";
import {
  ownedFeeReserve,
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
    aria-pressed={on}
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

const Group = ({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) => (
  <div className="mt-3 first:mt-0">
    <div className="mb-1 text-dim">{help ? <InfoTip label={label} help={help} /> : label}</div>
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
      {/* Quick Match plays its own fixed terms; these are for invites. */}
      <p className="mb-2 text-xs font-semibold tracking-wide text-dim uppercase">Private game</p>
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

      <Group
        label="Move timer"
        help="Time allowed for each move. If you run out, your opponent can claim the win."
      >
        {MOVE_PRESETS.map((daa) => (
          <Chip key={daa} on={moveTimeout === daa} onClick={() => saveMoveTimeout(daa)}>
            {fmtDaaDuration(daa)}
          </Chip>
        ))}
      </Group>

      {/* Stakes are discoverable during setup, separate from free gameplay. */}
      {owned ? (
        <div className="mt-3">
          <Group label="Stake">
            {STAKE_PRESETS.map((s) => {
              // Only once the balance is actually known — a null balance is
              // still loading, and greying the row out then reads as
              // "you're broke" to someone who isn't.
              const short = s > 0n && balance !== null && balance < s + ownedFeeReserve(1);
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
              Each player contributes the selected amount. The winner receives the pot.
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-dim">
              Play for free or choose a stake. Stakes use testnet KAS during beta.
            </p>
          )}
        </div>
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
