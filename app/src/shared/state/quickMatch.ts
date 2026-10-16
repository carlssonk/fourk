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
import { SEAT_GONE, createGame, errorAtom, runAction, sitDown, type HostTerms } from "./actions";
import { realDeps, type PollState, type QuickMatchDeps } from "./deps";
import { httpMatchmaker } from "../lib/matchmaker";
import { matchesAtom, removeMatch, showMatch, updateMatch } from "./matches";
import { isOpen } from "../lib/game";
import { timingFor } from "./profile";

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

/** How long the host waits on the panel for the join to land. */
const JOIN_WAIT_MS = 30_000;
/** Lobby posts before giving up: the matchmaker's HOST_GRACE_MS (30 s). */
const MAX_POST_ATTEMPTS = 15;

export const UNAVAILABLE =
  "Quick Match isn't available right now. You can still start a private game and send the link.";

const TERMS: HostTerms = {
  stake: 0n,
  timing: timingFor(QUICK_MATCH_MOVE_TIMEOUT),
  mode: "fourk2",
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
  while (live()) {
    let ticket: string;
    try {
      ticket = await deps.matchmaker.seek(myPk);
    } catch {
      return unavailable();
    }
    if (!live()) return;
    store.set(quickMatchAtom, { phase: "searching", since: Date.now() });
    const done = await follow(deps, ticket, live);
    if (done) return idle();
    await wait(POLL_MS);
  }
}

/** Poll one ticket to its end: true to stop (we're in a game, or there's
 * an error on screen), false to seek again. */
async function follow(deps: QuickMatchDeps, ticket: string, live: () => boolean): Promise<boolean> {
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
      if (!invite || !isQuickMatchTerms(invite)) return false;
      store.set(quickMatchAtom, { phase: "setting-up" });
      let taken = false;
      await runAction(async () => {
        try {
          await sitDown(invite, deps);
        } catch (e) {
          // Someone else got there first: not the player's problem.
          if ((e as Error)?.message !== SEAT_GONE) throw e;
          taken = true;
        }
      });
      if (!taken) markQuick(invite.covenantId);
      return !taken;
    }
    if (poll.state === "host" && !lobby) {
      store.set(quickMatchAtom, { phase: "setting-up" });
      // The open takes a while; the matchmaker drops a ticket that goes
      // quiet, so keep polling through it.
      const stopBeat = heartbeat(deps, ticket);
      await runAction(async () => {
        const opened = await createGame(deps, { terms: TERMS, show: false });
        lobby = updateMatch({ ...opened, quick: true });
      }).finally(stopBeat);
      if (!lobby || store.get(errorAtom)) return true;
      held = { deps, lobby };
      // Cancelled while the open was confirming.
      if (!live()) return closeLobby(deps, lobby);
      if (!(await post(deps, ticket, encodeShareCode(lobby), live))) return closeLobby(deps, lobby);
    } else if (poll.state === "matched" && lobby) {
      held = null;
      showMatch(await joinOf(lobby));
      return true;
    } else if (poll.state === "gone") {
      return lobby ? closeLobby(deps, lobby) : false;
    }
    await wait(POLL_MS);
  }
  return false;
}

/** The lobby's record once the partner's join is on it (the off-screen
 * watcher fills it in), so the host never sees the open-lobby screen; or
 * as it stands after JOIN_WAIT_MS, if the join is slow or failed. */
async function joinOf(lobby: Match): Promise<Match> {
  const record = () => store.get(matchesAtom).find((m) => m.covenantId === lobby.covenantId);
  for (let waited = 0; waited < JOIN_WAIT_MS; waited += 1_000) {
    const m = record();
    if (m && !isOpen(m.state)) return m;
    await wait(1_000);
  }
  return record() ?? lobby;
}

/** Note on the joined game's record that Quick Match paired it. */
function markQuick(covenantId: string): void {
  const m = store.get(matchesAtom).find((x) => x.covenantId === covenantId);
  if (m) updateMatch({ ...m, quick: true });
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

function idle(): void {
  run++;
  store.set(quickMatchAtom, { phase: "idle" });
}

/** Stop, closing any lobby, and say why. */
async function unavailable(): Promise<void> {
  await stopQuickMatch();
  // After the stop: the cancel's runAction clears the banner.
  store.set(errorAtom, UNAVAILABLE);
}

/** Leave the queue, cancelling any lobby nobody has been handed. */
export async function stopQuickMatch(): Promise<void> {
  idle();
  if (held) await closeLobby(held.deps, held.lobby);
}
