import { atom, getDefaultStore } from "jotai";
import { classifyFailure, friendlyCatch } from "../lib/errors";
import { ZERO_PK } from "../lib/game";
import { FREE_STAKE, SOMPI_PER_KAS, isStaked, saveCheckpoint, type Match } from "../lib/match";
import { refreshBalance } from "./balance";
import { realDeps, type Deps } from "./deps";
import {
  clearInvite,
  matchesAtom,
  openMatch,
  removeMatch,
  showMatch,
  unfinishedGamesOn,
  updateMatch,
} from "./matches";
import { modeOf } from "../modes/registry";
import type { GameModeKey } from "../modes/types";
import type { MatchTiming } from "../lib/covenant";
import { getRpc } from "./rpc";
import { matchWallet, ownedWallet } from "./wallet";
import { getDiscColor, getGameMode, getMatchTiming, getProfile, getStake } from "./profile";

/** Fee buffer reserved per unfinished staked game. A Fourk player pays for
 * a commit and a reveal or resolve every round, ~0.016 KAS each at the
 * relay floor (each carries the ~7.4 KB covenant script); a full board takes
 * 21+ rounds, so ~0.7 KAS, with headroom for a busier fee market. The
 * account panel's Max holds back one per unfinished game too. */
export const FEE_MARGIN = SOMPI_PER_KAS;

/** What a key must hold back for the games it already sits in, plus one
 * more if it is about to take a seat. */
export function feeReserve(pk: string, opening = 0): bigint {
  return FEE_MARGIN * BigInt(unfinishedGamesOn(store.get(matchesAtom), pk).length + opening);
}

/** feeReserve for the owned account (staked games only ever sit there). */
export function ownedFeeReserve(opening = 0): bigint {
  const pk = ownedWallet()?.myPk;
  return pk ? feeReserve(pk, opening) : FEE_MARGIN * BigInt(opening);
}

const store = getDefaultStore();

export const busyAtom = atom(false);
export const errorAtom = atom<string | null>(null);

/** The connect-to-game journey on screen: shown full-page while it runs. */
export interface Connecting {
  title: string;
  steps: readonly string[];
  /** Index of the step in progress; everything before it is done. */
  step: number;
}

export const connectingAtom = atom<Connecting | null>(null);

/** Begin a connect journey; `advanceConnecting` ticks steps off in order. */
export function startConnecting(title: string, steps: readonly string[]): void {
  store.set(connectingAtom, { title, steps, step: 0 });
}

export function advanceConnecting(): void {
  const c = store.get(connectingAtom);
  if (c) store.set(connectingAtom, { ...c, step: c.step + 1 });
}

export function clearError(): void {
  store.set(errorAtom, null);
}

/** Route any thrown value into the error banner, translated for players. */
export function reportError(e: unknown): void {
  store.set(errorAtom, friendlyCatch(e));
}

/** One user action at a time; failures land in the error banner. */
export async function runAction(action: () => Promise<void>): Promise<void> {
  if (store.get(busyAtom)) return;
  store.set(busyAtom, true);
  store.set(errorAtom, null);
  try {
    await action();
  } catch (e) {
    reportError(e);
  } finally {
    store.set(busyAtom, false);
    store.set(connectingAtom, null);
    // Money may have moved (stake out, pot in, cash-out) — show it now
    // rather than waiting for the subscription tick.
    void refreshBalance();
  }
}

/** What a game is hosted on, when not the player's own settings. */
export interface HostTerms {
  /** 0n for free. */
  stake: bigint;
  timing: MatchTiming;
  mode: GameModeKey;
}

/** The body of newGame, bare so other actions can chain into it (e.g. a
 * kick flows straight into hosting a fresh game). Call inside `runAction`.
 * `terms` replaces the player's settings (Quick Match); `show: false` puts
 * the game on record without opening it. */
export async function createGame(
  deps: Deps = realDeps,
  { terms, show = true }: { terms?: HostTerms; show?: boolean } = {},
): Promise<Match> {
  // A remembered stake means nothing without an account to pay it from —
  // a guest always hosts free, whatever the setting says.
  const stakeSetting = terms ? terms.stake : deps.account.hasOwnedAccount() ? getStake() : 0n;
  const staked = stakeSetting > 0n;
  const stake = staked ? stakeSetting : FREE_STAKE;
  startConnecting("Creating your game", [
    staked ? "Connecting to the Kaspa network" : "Connecting to the game",
    staked ? "Placing your stake" : "Preparing your seat",
    staked ? "Opening the game on-chain" : "Creating your invite link",
  ]);
  // Free games are seated by the invisible guest key and paid for by the
  // dispenser; staked games are seated by the player's own account. The two
  // pots of money never meet.
  const { key, myPk } = deps.account.signingWallet({ staked });
  await deps.chain.connect();
  advanceConnecting();
  await deps.chain.ensureFunds(key, stake + feeReserve(myPk, 1), { staked });
  advanceConnecting();
  // Checkpoint the chain from before the open: a join spends the genesis
  // UTXO, and scanning blocks forward from here finds it even if this tab
  // is long gone by then (the watcher persists fresher checkpoints while
  // it runs, this is the floor).
  const preOpen = await deps.chain.chainCheckpoint();
  const me = getProfile();
  // My identity and disc colour travel to the opponent inside the link;
  // they take the other colour.
  const dress = (m: Match): Match => ({
    ...m,
    ...(me.name && { profiles: { p1: me } }),
    ...(getDiscColor() === "blue" && { p1Color: "blue" as const }),
  });
  // Stored the moment the stake is about to leave: a reload while the open
  // confirms must not strand a staked lobby with no record and no cancel.
  let pending: string | null = null;
  try {
    const timing = terms?.timing ?? getMatchTiming();
    const mode = terms?.mode ?? getGameMode();
    const match = await deps.chain.openMatch(key, stake, timing, mode, (m) => {
      pending = m.covenantId;
      saveCheckpoint(m.covenantId, preOpen);
      updateMatch(dress(m));
    });
    saveCheckpoint(match.covenantId, preOpen);
    const stored = updateMatch(dress(match));
    if (show) showMatch(stored);
    return stored;
  } catch (e) {
    // Only a refused transaction is known not to exist; after a dropped
    // connection it may have landed, and the record is how it gets found.
    if (pending && classifyFailure(e) !== "transient") removeMatch(pending);
    throw e;
  }
}

/** Open a fresh game with the free stake. */
export const newGame = (): Promise<void> =>
  runAction(async () => {
    await createGame();
  });

/** What a join throws when the seat went before we got there. */
export const SEAT_GONE =
  "This game is no longer open. Someone else took the seat, or the host called it off.";

/** Sit down at an invite — or reopen a known game, or spectate. */
export const takeSeat = (invite: Match, deps: Deps = realDeps): Promise<void> =>
  runAction(() => sitDown(invite, deps));

/** The body of takeSeat, bare like createGame. Call inside `runAction`. */
export async function sitDown(invite: Match, deps: Deps = realDeps): Promise<void> {
  const known = store.get(matchesAtom).find((m) => m.covenantId === invite.covenantId);
  if (known) {
    // A game we're already in: reopen our TRACKED state, never the link's. An
    // invite is attacker-controlled and only has to be genesis-reachable, so
    // a higher-progress link must not overwrite the match the chain-connected
    // watcher maintains — that is exactly the blinding vector. The watcher
    // advances `known` from the chain; the link never does.
    openMatch(known);
    clearInvite();
    return;
  }
  // Whether the open seat is ours to take is a question about the key
  // that WOULD sit in it — but resolving that key must not happen until
  // we know we're joining: a guest opening a staked link is a spectator,
  // and asking for an owned account there would throw at them.
  const seatOpen = invite.state.p2 === ZERO_PK;
  const iAmHost = seatOpen && deps.account.matchWallet(invite)?.myPk === invite.state.p1;
  if (seatOpen && !iAmHost) {
    const staked = isStaked(invite);
    const { key, myPk } = deps.account.signingWallet({ staked });
    startConnecting("Joining the game", [
      staked ? "Connecting to the Kaspa network" : "Connecting to the game",
      staked ? "Placing your stake" : "Preparing your seat",
      staked ? "Taking your seat on-chain" : "Joining your opponent",
    ]);
    await deps.chain.connect();
    // A deadline the chain has already passed (or nearly so) is a trap —
    // the host could sudden-death the pot back out from under us — and the
    // covenant cannot check it (script proves time passed, never time
    // remaining). Refuse before any funds move.
    await deps.chain.assertJoinableDeadline(invite);
    advanceConnecting();
    await deps.chain.ensureFunds(key, invite.value + feeReserve(myPk, 1), { staked });
    advanceConnecting();
    try {
      // Checkpoint from before the join: the host may act the moment they
      // see us arrive, and without a stored checkpoint the joiner's
      // watcher could never trace that spend (it would just sit stuck).
      const preJoin = await deps.chain.chainCheckpoint();
      saveCheckpoint(invite.covenantId, preJoin);
      // My profile rides the join tx's payload so P1 learns who sat down.
      // Stored before the stake leaves (see createGame).
      let submitted = false;
      try {
        const joined = await deps.chain.joinMatch(key, invite, getProfile(), (m) => {
          submitted = true;
          updateMatch(m);
        });
        openMatch(joined);
        clearInvite();
      } catch (e) {
        if (submitted && classifyFailure(e) !== "transient") removeMatch(invite.covenantId);
        throw e;
      }
    } catch (e) {
      // The genesis UTXO being gone has one meaning here: the seat is no
      // longer up for grabs. Say that, not "sync first".
      if (/game UTXO not found/.test(String((e as any)?.message ?? e)))
        throw new Error(SEAT_GONE, { cause: e });
      throw e;
    }
  } else {
    openMatch(invite); // a game in progress or spectating
    clearInvite();
  }
}

/** Send a decided pot from the match list without opening the game (see
 * `ModeActions.collect`), and record the ending on the stored match. */
export const collectMatch = (m: Match): Promise<void> =>
  runAction(async () => {
    const collect = modeOf(m).actions.collect;
    const myPk = matchWallet(m)?.myPk;
    if (!collect || !myPk) return;
    const result = await collect(await getRpc(), m);
    updateMatch({ ...m, result });
  });
