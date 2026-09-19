import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
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

const SettingHelp = ({ label, help }: { label: string; help: string }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  const leaveHelp = (target: EventTarget | null) => {
    if (pinned.current || document.activeElement === button.current) return;
    if (
      target instanceof Node &&
      (button.current?.contains(target) || tooltip.current?.contains(target))
    )
      return;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !tooltip.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="relative flex items-center text-dim">
      {label}
      <button
        ref={button}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        className="ml-0.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim hover:text-ink"
        onFocus={() => setOpen(true)}
        onBlur={close}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={(event) => leaveHelp(event.relatedTarget)}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-3.5 items-center justify-center rounded-full border border-current font-serif text-[10px]"
        >
          i
        </span>
      </button>
      {open && (
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          onMouseLeave={(event) => leaveHelp(event.relatedTarget)}
          className="absolute bottom-full left-0 z-20 w-80 max-w-full rounded-lg border border-line bg-panel px-3 py-2 text-xs leading-relaxed text-ink shadow-lg"
        >
          {help}
        </div>
      )}
    </div>
  );
};

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
    <div className="mb-1 text-dim">{help ? <SettingHelp label={label} help={help} /> : label}</div>
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
