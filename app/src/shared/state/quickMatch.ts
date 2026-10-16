/**
 * Quick Match (docs/adr/0003): queue at the matchmaker, then either host a
 * lobby on the Quick Match terms or join the partner's. The loop lives in
 * the state layer, not a component, so it keeps running whatever is on
 * screen.
 */

import { atom, getDefaultStore } from "jotai";
import { encodeShareCode, type Match } from "../lib/match";
import { parseInvite } from "../lib/invite";
import { QUICK_MATCH_MOVE_TIMEOUT, isQuickMatchTerms } from "../lib/quickMatch";
import {
  SEAT_GONE,
  createGame,
  errorAtom,
  runAction,
  sitDown,
  connectingAtom,
  type HostTerms,
  type Journey,
} from "./actions";
import { realDeps, type PollState, type QuickMatchDeps } from "./deps";
import { SEEK_LIMITED, httpMatchmaker } from "../lib/matchmaker";
import { matchesAtom, removeMatch, showMatch } from "./matches";
import { isOpen } from "../lib/game";
import { getGameMode, timingFor } from "./profile";
import type { GameModeKey } from "../modes/types";

export type QuickMatchStatus =
  | { phase: "idle" }
  /** In the queue since `since` (Date.now()). */
  | { phase: "searching"; since: number }
  /** Paired: the game is being opened or joined. */
  | { phase: "setting-up" };

export const quickMatchAtom = atom<QuickMatchStatus>({ phase: "idle" });

/** Between matchmaker polls. */
export const POLL_MS = 2_000;
/** Failed polls in a row before giving up: by then the matchmaker has
 * dropped the ticket anyway (its POLL_GRACE_MS). */
const MAX_POLL_FAILURES = 5;

/** How long the host waits on the panel for the join to land: room for a
 * first-time guest's dispenser claim and the join's acceptance on testnet.
 * A join that lands after it still beats the cancel (closeLobby). */
const JOIN_WAIT_MS = 60_000;
/** Lobby posts before giving up: the matchmaker's HOST_GRACE_MS (30 s). */
const MAX_POST_ATTEMPTS = 15;

const SEARCHED_TOO_OFTEN =
  "Quick Match has had a lot of searches from this connection. Try again in a minute.";

export const UNAVAILABLE =
  "Quick Match isn't available right now. You can still start a private game and send the link.";

/** Between a Quick Match host's open and the join: generous, since a
 * pairing that slow has long been dropped by the matchmaker. */
const CAP_SLACK_DAA = 36_000;

/** What a Quick Match host opens: the player's mode, otherwise fixed. */
const termsFor = (mode: GameModeKey): HostTerms => ({
  stake: 0n,
  timing: timingFor(QUICK_MATCH_MOVE_TIMEOUT),
  mode,
  quick: true,
});

/** The connect screens once paired: the opponent is found first, then the
 * game is made (no invite link: nobody shares one). Free games only. */
const HOSTING: Journey = {
  title: "Found an opponent",
  steps: [
    "Connecting to the game",
    "Preparing your seat",
    "Creating the game",
    "Waiting for your opponent to join",
  ],
};
const JOINING: Journey = {
  title: "Found an opponent",
  steps: ["Connecting to the game", "Preparing your seat", "Joining the game"],
};

const store = getDefaultStore();
/** Bumped by every start and stop: a loop whose run is stale exits. */
let run = 0;
/** A lobby we opened that nobody has been handed yet: Cancel closes it. */
let held: { deps: QuickMatchDeps; lobby: Match } | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startQuickMatch(
  deps: QuickMatchDeps = { ...realDeps, matchmaker: httpMatchmaker },
): Promise<void> {
  const mine = ++run;
  const live = () => mine === run;
  const { myPk } = deps.account.signingWallet({ staked: false });
  // Read at the press: the mode picker stays live on screen meanwhile.
  const terms = termsFor(getGameMode());
  // One search, however many tickets it takes: the wait shown counts from
  // the press, not from the latest requeue.
  const since = Date.now();
  while (live()) {
    let ticket: string;
    try {
      ticket = await deps.matchmaker.seek(myPk, terms.mode);
    } catch (e) {
      return unavailable((e as Error)?.message === SEEK_LIMITED ? SEARCHED_TOO_OFTEN : UNAVAILABLE);
    }
    if (!live()) return;
    store.set(quickMatchAtom, { phase: "searching", since });
    const done = await follow(deps, terms, ticket, live, since);
    if (done) return idle();
    await wait(POLL_MS);
  }
}

/** Poll one ticket to its end: true to stop (we're in a game, or there's
 * an error on screen), false to seek again. */
async function follow(
  deps: QuickMatchDeps,
  terms: HostTerms,
  ticket: string,
  live: () => boolean,
  since: number,
): Promise<boolean> {
  /** The lobby we opened as host, once there is one. */
  let lobby: Match | null = null;
  let failures = 0;
  while (live()) {
    let poll: PollState;
    try {
      poll = await deps.matchmaker.poll(ticket);
      failures = 0;
    } catch {
      if (++failures >= MAX_POLL_FAILURES) {
        await unavailable();
        return true;
      }
      await wait(POLL_MS);
      continue;
    }
    if (!live()) return false;
    if (poll.state === "join") {
      // The matchmaker is not trusted with the terms: check them here.
      const invite = parseInvite(poll.code);
      if (!invite || !isQuickMatchTerms(invite, terms.mode)) return false;
      store.set(quickMatchAtom, { phase: "setting-up" });
      let skipped = false;
      await runAction(async () => {
        try {
          // The cap is an absolute score the terms can't compare, so hold it
          // to the preset here: a short one would cut the game off early.
          const minRemaining = terms.timing.totalCap - CAP_SLACK_DAA;
          // Marked paired on our record: Classic has no flag for it on chain.
          await sitDown({ ...invite, paired: true }, deps, { minRemaining, journey: JOINING });
        } catch (e) {
          // Someone else got there first, or the lobby's limit is off the
          // terms: not the player's problem, find another.
          const why = (e as Error)?.message;
          if (why !== SEAT_GONE && why !== "DEADLINE_TOO_CLOSE") throw e;
          skipped = true;
        }
      });
      return !skipped;
    }
    if (poll.state === "host" && !lobby) {
      store.set(quickMatchAtom, { phase: "setting-up" });
      // The open takes a while; the matchmaker drops a ticket that goes
      // quiet, so keep polling through it.
      const stopBeat = heartbeat(deps, ticket);
      await runAction(async () => {
        lobby = await createGame(deps, { terms, show: false, journey: HOSTING });
        // Straight on to the last step, on the same screen: no gap for the
        // panel underneath to show through while the lobby is posted.
        showWaiting(true);
      }).finally(stopBeat);
      if (!lobby || store.get(errorAtom)) return true;
      held = { deps, lobby };
      // Cancelled while the open was confirming.
      if (!live()) return closeLobby(deps, lobby);
      if (!(await post(deps, ticket, encodeShareCode(lobby), live))) return closeLobby(deps, lobby);
    } else if (poll.state === "open" && lobby) {
      // The partner left before taking the lobby; it stays up for the next.
      showWaiting(false);
      store.set(quickMatchAtom, { phase: "searching", since });
    } else if (poll.state === "hosted" && lobby) {
      store.set(quickMatchAtom, { phase: "setting-up" });
      showWaiting(true);
    } else if (poll.state === "matched" && lobby) {
      // Still held while the join lands, so Cancel can close it meanwhile.
      const joined = await joinOf(lobby, live);
      if (!live()) return false;
      if (joined) {
        held = null;
        showMatch(joined);
        showWaiting(false);
        return true;
      }
      // The partner took the code and never joined: close the empty lobby
      // and look again, rather than opening it with nobody coming.
      return closeLobby(deps, lobby);
    } else if (poll.state === "gone") {
      return lobby ? closeLobby(deps, lobby) : false;
    }
    await wait(POLL_MS);
  }
  return false;
}

/** The lobby's record once the partner's join is on it (the off-screen
 * watcher fills it in), so the host never sees the open-lobby screen; null
 * if it hasn't landed within JOIN_WAIT_MS. */
async function joinOf(lobby: Match, live: () => boolean): Promise<Match | null> {
  for (let waited = 0; waited < JOIN_WAIT_MS && live(); waited += 1_000) {
    const m = store.get(matchesAtom).find((x) => x.covenantId === lobby.covenantId);
    if (m && !isOpen(m.state)) return m;
    await wait(1_000);
  }
  return null;
}

/** Poll in the background, ignoring the answers, until the returned stop
 * is called. */
function heartbeat(deps: QuickMatchDeps, ticket: string): () => void {
  let beating = true;
  void (async () => {
    for (;;) {
      await wait(POLL_MS);
      if (!beating) return;
      await deps.matchmaker.poll(ticket).catch(() => {});
    }
  })();
  return () => {
    beating = false;
  };
}

/** Post the lobby until the matchmaker's node has it; false if it never
 * takes it (refused, unseen past the host grace, or no answer). */
async function post(
  deps: QuickMatchDeps,
  ticket: string,
  code: string,
  live: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
    if (!live()) return true; // stopQuickMatch closes the lobby
    try {
      const reply = await deps.matchmaker.hosted(ticket, code);
      if (reply !== "retry") return reply === "ok";
    } catch {
      // Unreachable for now: try again.
    }
    await wait(POLL_MS);
  }
  return false;
}

/** Cancel a lobby nobody is coming to. True to stop: a join beat the
 * cancel and we're in a game after all, or the cancel failed (the error is
 * on screen and the lobby stays on record with its own Cancel). */
async function closeLobby(deps: QuickMatchDeps, lobby: Match): Promise<boolean> {
  held = null;
  showWaiting(false);
  let joined = false;
  await runAction(async () => {
    const { key } = deps.account.signingWallet({ staked: false });
    try {
      await deps.chain.cancelMatch(key, lobby);
      removeMatch(lobby.covenantId);
    } catch (e) {
      if (!/game UTXO not found/.test(String((e as Error)?.message ?? e))) throw e;
      joined = true;
    }
  });
  if (joined) showMatch(lobby);
  return joined || !!store.get(errorAtom);
}

/** The host's last step on the same Found an opponent screen: the game is
 * made, the opponent is taking their seat. */
function showWaiting(on: boolean): void {
  const shown = store.get(connectingAtom)?.cancel === cancelSearch;
  if (on && !shown)
    store.set(connectingAtom, {
      title: HOSTING.title,
      steps: HOSTING.steps,
      step: HOSTING.steps.length - 1,
      cancel: cancelSearch,
    });
  else if (!on && shown) store.set(connectingAtom, null);
}

const cancelSearch = () => void stopQuickMatch();

function idle(): void {
  run++;
  showWaiting(false);
  store.set(quickMatchAtom, { phase: "idle" });
}

/** Stop, closing any lobby, and say why. */
async function unavailable(why = UNAVAILABLE): Promise<void> {
  await stopQuickMatch();
  // After the stop: the cancel's runAction clears the banner.
  store.set(errorAtom, why);
}

/** Leave the queue, cancelling any lobby nobody has been handed. */
export async function stopQuickMatch(): Promise<void> {
  idle();
  if (held) await closeLobby(held.deps, held.lobby);
}
