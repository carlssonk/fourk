import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { Avatar } from "@shared/components/Avatar";
import { HowToPlayDialog } from "@shared/components/HowToPlayDialog";
import { InfoTip } from "@shared/components/InfoTip";
import { isOpen } from "@shared/lib/game";
import { fmtDaaDuration, fmtKas, isStaked } from "@shared/lib/match";
import { MODES, modeOf } from "@shared/modes/registry";
import {
  FEE_MARGIN,
  ownedFeeReserve,
  accountPanelAtom,
  balanceAtom,
  busyAtom,
  clearInvite,
  collectMatch,
  gameModeAtom,
  hasOwnedAccount,
  matchesAtom,
  newGame,
  pendingInviteAtom,
  quickMatchAtom,
  removeMatch,
  showMatch,
  startQuickMatch,
  stopQuickMatch,
  takeSeat,
} from "@shared/state";
import { HAS_QUICK_MATCH } from "@shared/lib/matchmaker";
import { QUICK_MATCH_MOVE_TIMEOUT } from "@shared/lib/quickMatch";
import { useCapClock } from "../game/hooks/useCapClock";
import {
  AboutDialog,
  BoardBackdrop,
  MatchList,
  ModeSettings,
  PlayerSetup,
  PrivateGameSettings,
  QuickMatchPanel,
  usePrivateGameSummary,
} from "./components";
import { useCollectable, useMatchGlances } from "./hooks";

export const Home = () => {
  const pendingInvite = useAtomValue(pendingInviteAtom);
  const matches = useAtomValue(matchesAtom);
  const busy = useAtomValue(busyAtom);
  const balance = useAtomValue(balanceAtom);
  // Money only exists on screen for players who asked for an account.
  const owned = hasOwnedAccount();
  const openAccount = useSetAtom(accountPanelAtom);
  const glances = useMatchGlances();
  const collectable = useCollectable();
  // The whole-game cap is a term of the deal — show the actual time left,
  // not just that a cap exists: an invite whose cap is nearly spent would
  // sudden-death the pot into an even split mid-game.
  const inviteCapLeft = useCapClock(pendingInvite, !!pendingInvite);
  const [about, setAbout] = useState(false);
  const [rules, setRules] = useState(false);
  const quick = useAtomValue(quickMatchAtom);
  const gameMode = useAtomValue(gameModeAtom);
  const privateTerms = usePrivateGameSummary();
  const [tweaking, setTweaking] = useState(false);

  if (pendingInvite) {
    // Chat apps open links in their own browser, with storage apart from
    // the phone's browser, and iOS gives it the plain Safari user agent, so
    // it can't be detected. Seat keys and sealed picks live in that storage,
    // so a game joined there can't be finished anywhere else. Desktop chat
    // apps open the system browser, so the note is for phones only.
    const onPhone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const host = pendingInvite.profiles?.p1;
    const myColor = pendingInvite.p1Color === "blue" ? "red" : "blue";
    const inviteMeta = modeOf(pendingInvite).meta;
    const joinStake = pendingInvite.state.stake;
    // A staked seat is paid from the joiner's own balance — gate the button
    // here so the shortfall is an "add funds" moment, not an error banner.
    // Only while the seat is actually open: a link to a running game just
    // spectates and costs nothing.
    const seatOpen = isOpen(pendingInvite.state);
    const staked = isStaked(pendingInvite);
    const need = staked && seatOpen ? joinStake + ownedFeeReserve(1) : 0n;
    // Two different blockers, two different fixes: a guest needs an account
    // before they can stake anything; an account holder just needs funds.
    const needsAccount = need > 0n && !owned;
    const short = need > 0n && owned && balance !== null && balance < need;
    const colorClass = myColor === "red" ? "text-red" : "text-blue";
    const perMove = `${fmtDaaDuration(pendingInvite.state.moveTimeout)} per ${inviteMeta.moveNoun}.`;
    return (
      // Sized to fit a phone screen without scrolling (staked invite on a
      // 390x664 viewport): the host's avatar sits beside the headline there,
      // and the spacing tightens below sm.
      <div className="pt-1 pb-4 text-center sm:pt-8 sm:pb-8">
        <BoardBackdrop />
        <div className="mb-1.5 flex items-center justify-center gap-3 sm:flex-col sm:gap-1">
          {host && (
            <div className="w-11 shrink-0 sm:w-18">
              <Avatar code={host.avatar} size={72} fluid className="block" />
            </div>
          )}
          <h2 className="text-xl font-bold text-balance sm:text-2xl">
            {!seatOpen
              ? "Watch this game"
              : `${host?.name ? `${host.name} invited you` : "You're invited"} to play ${inviteMeta.label}`}
          </h2>
        </div>
        {!seatOpen ? (
          <p className="text-dim">Both seats are taken. You can follow along.</p>
        ) : !staked ? (
          <p className="text-dim">
            You play <b className={colorClass}>{myColor}</b>.
          </p>
        ) : (
          <dl className="mx-auto mt-2 flex w-fit gap-6 rounded-lg border border-line bg-panel/60 px-5 py-2 sm:gap-8">
            <div>
              <dt className="text-xs text-dim">You play</dt>
              <dd className={`text-lg font-semibold capitalize ${colorClass}`}>{myColor}</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Your stake</dt>
              <dd className="text-lg font-semibold">{fmtKas(joinStake)} KAS</dd>
              {/* Held back, not charged: what's left after the game's
               * transaction fees stays in the balance. */}
              <dd>
                <InfoTip
                  label={`+ ${fmtKas(FEE_MARGIN)} KAS fees`}
                  help="Network fees: every move is a Kaspa transaction, and the network charges a small fee for each. This amount stays in your balance to pay them, and whatever isn't used stays yours. None of it goes to fourk.io."
                  align="center"
                  className="justify-center text-[11px]"
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Winner gets</dt>
              <dd className="text-lg font-semibold text-accent">{fmtKas(joinStake * 2n)} KAS</dd>
            </div>
          </dl>
        )}
        {short && (
          <p className="mt-2 text-sm text-red">
            You need {fmtKas(need)} KAS and have {fmtKas(balance)}.{" "}
            <button className="cursor-pointer underline" onClick={() => openAccount("add-funds")}>
              Add funds
            </button>
          </p>
        )}
        {seatOpen ? (
          <PlayerSetup
            actionLabel={needsAccount ? "Create an account to join" : "Join"}
            busy={busy || short}
            onSubmit={() => (needsAccount ? openAccount("get-started") : takeSeat(pendingInvite))}
          />
        ) : (
          <div className="my-5">
            <button className="btn" disabled={busy} onClick={() => takeSeat(pendingInvite)}>
              Watch game
            </button>
          </div>
        )}
        <p className="text-sm text-dim">
          {perMove}
          {inviteCapLeft &&
            (inviteCapLeft === "any moment"
              ? " The game's time limit is almost up."
              : ` The game ends in ${inviteCapLeft}.`)}
        </p>
        <div className="mt-1 flex justify-center gap-5 text-sm text-dim">
          <button
            type="button"
            className="cursor-pointer underline hover:text-ink"
            onClick={() => setRules(true)}
          >
            How {inviteMeta.label} works
          </button>
          <button
            type="button"
            className="cursor-pointer underline hover:text-ink disabled:cursor-default"
            disabled={busy}
            onClick={clearInvite}
          >
            Not now
          </button>
        </div>
        {seatOpen && onPhone && (
          <p className="mt-3 text-sm text-dim">
            Opened from Discord or another app? Open this link in your browser first.
          </p>
        )}
        {rules && (
          <HowToPlayDialog
            mode={inviteMeta}
            moveTimeout={pendingInvite.state.moveTimeout}
            staked={staked}
            showCap={inviteCapLeft !== null}
            onDismiss={() => setRules(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div data-screen="home" className="pt-8 pb-8 text-center">
      <BoardBackdrop />
      {/* The wordmark wears the accent — Kaspa's own teal — so the page has
       * one identity colour from title to primary button. */}
      <h2 className="mb-1.5 font-display text-4xl font-extrabold tracking-tight text-accent">
        fourk<span className="text-base font-medium tracking-normal text-dim"> .io</span>
        <span className="ml-2 rounded-full border border-line px-2 py-0.5 align-middle text-xs font-medium tracking-normal text-dim">
          beta
        </span>
      </h2>
      <p className="text-sm text-dim">
        connect four on Kaspa •{" "}
        <button className="cursor-pointer underline" onClick={() => setAbout(true)}>
          about
        </button>
      </p>
      <div className="relative mx-auto w-fit max-w-full">
        <div className="max-w-full">
          {quick.phase === "idle" ? (
            <>
              <PlayerSetup
                actionLabel="Private Game"
                headlineLabel="Quick Match"
                onHeadline={HAS_QUICK_MATCH ? () => void startQuickMatch() : undefined}
                headlineNote={`Free · ${fmtDaaDuration(QUICK_MATCH_MOVE_TIMEOUT)} per ${
                  MODES[gameMode].meta.moveNoun
                }`}
                busy={busy}
                onSubmit={newGame}
                // Mode above both buttons, since both play it; the clock and
                // stake under Private Game, the only one they apply to.
                settings={<ModeSettings />}
                actionNote={
                  <>
                    {privateTerms} ·{" "}
                    <button
                      type="button"
                      className="cursor-pointer underline hover:text-ink"
                      aria-expanded={tweaking}
                      onClick={() => setTweaking(!tweaking)}
                    >
                      {tweaking ? "done" : "change"}
                    </button>
                  </>
                }
                pickDiscColor
              />
              {tweaking && (
                <div className="card mx-auto mb-5 w-115 max-w-full p-4 text-left">
                  <PrivateGameSettings />
                </div>
              )}
            </>
          ) : (
            <QuickMatchPanel
              status={quick}
              busy={busy}
              onCancel={() => void stopQuickMatch()}
              onPrivateGame={async () => {
                await stopQuickMatch();
                await newGame();
              }}
            />
          )}
        </div>
        {/* Hung off the create column's left edge on wide screens so the
         * create flow stays on the page's center axis; stacked below it
         * otherwise. */}
        {matches.length > 0 && (
          <aside className="mx-auto mt-10 w-full max-w-115 xl:absolute xl:top-5 xl:right-full xl:mt-0 xl:mr-6 xl:w-64">
            <MatchList
              matches={matches}
              glances={glances}
              collectable={collectable}
              busy={busy}
              onOpen={showMatch}
              onCollect={collectMatch}
              onRemove={(m) => removeMatch(m.covenantId)}
            />
          </aside>
        )}
      </div>
      {about && <AboutDialog onDismiss={() => setAbout(false)} />}
    </div>
  );
};
