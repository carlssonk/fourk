import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { Avatar } from "@shared/components/Avatar";
import { isOpen } from "@shared/lib/game";
import { fmtDaaDuration, fmtKas, isStaked } from "@shared/lib/match";
import { modeOf } from "@shared/modes/registry";
import {
  FEE_MARGIN,
  accountPanelAtom,
  balanceAtom,
  busyAtom,
  clearInvite,
  hasOwnedAccount,
  matchesAtom,
  newGame,
  pendingInviteAtom,
  showMatch,
  takeSeat,
} from "@shared/state";
import { useCapClock } from "../game/hooks/useCapClock";
import { AboutDialog, BoardBackdrop, MatchList, MatchSettings, PlayerSetup } from "./components";
import { useMatchGlances } from "./hooks";

export const Home = () => {
  const pendingInvite = useAtomValue(pendingInviteAtom);
  const matches = useAtomValue(matchesAtom);
  const busy = useAtomValue(busyAtom);
  const balance = useAtomValue(balanceAtom);
  // Money only exists on screen for players who asked for an account.
  const owned = hasOwnedAccount();
  const openAccount = useSetAtom(accountPanelAtom);
  const glances = useMatchGlances();
  // The whole-game cap is a term of the deal — show the actual time left,
  // not just that a cap exists: an invite whose cap is nearly spent would
  // sudden-death the pot into an even split mid-game.
  const inviteCapLeft = useCapClock(pendingInvite, !!pendingInvite);
  const [about, setAbout] = useState(false);

  if (pendingInvite) {
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
    const need = staked && seatOpen ? joinStake + FEE_MARGIN : 0n;
    // Two different blockers, two different fixes: a guest needs an account
    // before they can stake anything; an account holder just needs funds.
    const needsAccount = need > 0n && !owned;
    const short = need > 0n && owned && balance !== null && balance < need;
    return (
      <div className="pt-8 pb-8 text-center">
        <BoardBackdrop />
        {host && <Avatar code={host.avatar} size={72} className="mx-auto mb-1" />}
        <h2 className="mb-1.5 text-2xl font-bold">
          {host?.name ? `${host.name} invited you to a game!` : "You've been invited to a game!"}
        </h2>
        <p className="text-sm text-dim">
          {inviteMeta.inviteBlurb}
          <b className={myColor === "red" ? "text-red" : "text-blue"}>{myColor} ●</b>.
        </p>
        {staked ? (
          <p className="mt-1 text-sm">
            <b className="text-accent">Winner takes the {fmtKas(joinStake * 2n)} KAS pot.</b>{" "}
            <span className="text-dim">
              {seatOpen && <>Joining puts in {fmtKas(joinStake)} KAS from your balance · </>}
              {fmtDaaDuration(pendingInvite.state.moveTimeout)} per {inviteMeta.moveNoun}
              {inviteCapLeft &&
                (inviteCapLeft === "any moment" ? (
                  <> · time cap already spent</>
                ) : (
                  <> · game ends in {inviteCapLeft}</>
                ))}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-dim">
            Free game — your seat is funded for you ·{" "}
            {fmtDaaDuration(pendingInvite.state.moveTimeout)} per {inviteMeta.moveNoun}
            {inviteCapLeft && <> · game ends in {inviteCapLeft}</>}
          </p>
        )}
        {needsAccount && (
          <p className="mt-2 text-sm">
            Staked games need an account — it's what holds your funds.{" "}
            <button className="cursor-pointer underline" onClick={() => openAccount("get-started")}>
              Create one
            </button>{" "}
            to join.
          </p>
        )}
        {short && (
          <p className="mt-2 text-sm text-red">
            You need {fmtKas(need)} KAS to join — you have {fmtKas(balance)}.{" "}
            <button className="cursor-pointer underline" onClick={() => openAccount("add-funds")}>
              Add funds
            </button>
          </p>
        )}
        <PlayerSetup
          actionLabel="Join"
          busy={busy || short || needsAccount}
          onSubmit={() => takeSeat(pendingInvite)}
        />
        <button className="btn" disabled={busy} onClick={clearInvite}>
          Not now
        </button>
      </div>
    );
  }

  return (
    <div className="pt-8 pb-8 text-center">
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
          <PlayerSetup
            actionLabel="Private Game"
            headlineLabel="Quick Match"
            busy={busy}
            onSubmit={newGame}
            settings={<MatchSettings />}
            pickDiscColor
          />
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
      {about && <AboutDialog onDismiss={() => setAbout(false)} />}
    </div>
  );
};
