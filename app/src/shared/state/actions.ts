import { atom, getDefaultStore } from "jotai";
import { friendlyCatch } from "../lib/errors";
import { ZERO_PK } from "../lib/game";
import { FREE_STAKE, SOMPI_PER_KAS, isStaked, saveCheckpoint, type Match } from "../lib/match";
import { fresherOf } from "../modes/registry";
import { refreshBalance } from "./balance";
import { realDeps, type Deps } from "./deps";
import { clearInvite, matchesAtom, openMatch } from "./matches";
import { getDiscColor, getGameMode, getMatchTiming, getProfile, getStake } from "./profile";

/** Fee buffer reserved alongside a stake — covers a whole game's worth of
 * transaction fees. The account panel's Max also holds this back while any
 * game is unfinished. */
export const FEE_MARGIN = SOMPI_PER_KAS / 2n;

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

/** The body of newGame, bare so other actions can chain into it (e.g. a
 * kick flows straight into hosting a fresh game). Call inside `runAction`. */
export async function createGame(deps: Deps = realDeps): Promise<void> {
  // A remembered stake means nothing without an account to pay it from —
  // a guest always hosts free, whatever the setting says.
  const stakeSetting = deps.account.hasOwnedAccount() ? getStake() : 0n;
  const staked = stakeSetting > 0n;
  const stake = staked ? stakeSetting : FREE_STAKE;
  startConnecting("Creating your game", [
    "Connecting to the Kaspa network",
    staked ? "Placing your stake" : "Topping up your stake",
    "Opening the game on-chain",
  ]);
  // Free games are seated by the invisible guest key and paid for by the
  // dispenser; staked games are seated by the player's own account. The two
  // pots of money never meet.
  const { key } = deps.account.signingWallet({ staked });
  await deps.chain.connect();
  advanceConnecting();
  await deps.chain.ensureFunds(key, stake + FEE_MARGIN, { staked });
  advanceConnecting();
  // Checkpoint the chain from before the open: a join spends the genesis
  // UTXO, and scanning blocks forward from here finds it even if this tab
  // is long gone by then (the watcher persists fresher checkpoints while
  // it runs, this is the floor).
  const preOpen = await deps.chain.chainCheckpoint();
  const match = await deps.chain.openMatch(key, stake, getMatchTiming(), getGameMode());
  saveCheckpoint(match.covenantId, preOpen);
  const me = getProfile();
  // My identity and disc colour travel to the opponent inside the link;
  // they take the other colour.
  openMatch({
    ...match,
    ...(me.name && { profiles: { p1: me } }),
    ...(getDiscColor() === "blue" && { p1Color: "blue" as const }),
  });
}

/** Open a fresh game with the free stake. */
export const newGame = (): Promise<void> => runAction(createGame);

/** Sit down at an invite — or reopen a known game, or spectate. */
export const takeSeat = (invite: Match, deps: Deps = realDeps): Promise<void> =>
  runAction(async () => {
    clearInvite();
    const known = store.get(matchesAtom).find((m) => m.covenantId === invite.covenantId);
    if (known) {
      // A game we're already in: just reopen it, at whichever state is fresher.
      openMatch(fresherOf(known, invite));
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
      const { key } = deps.account.signingWallet({ staked });
      startConnecting("Joining the game", [
        "Connecting to the Kaspa network",
        staked ? "Placing your stake" : "Topping up your stake",
        "Taking your seat on-chain",
      ]);
      await deps.chain.connect();
      // A deadline the chain has already passed (or nearly so) is a trap —
      // the host could sudden-death the pot back out from under us — and the
      // covenant cannot check it (script proves time passed, never time
      // remaining). Refuse before any funds move.
      await deps.chain.assertJoinableDeadline(invite);
      advanceConnecting();
      await deps.chain.ensureFunds(key, invite.value + FEE_MARGIN, { staked });
      advanceConnecting();
      try {
        // Checkpoint from before the join: the host may act the moment they
        // see us arrive, and without a stored checkpoint the joiner's
        // watcher could never trace that spend (it would just sit stuck).
        const preJoin = await deps.chain.chainCheckpoint();
        // My profile rides the join tx's payload so P1 learns who sat down.
        const joined = await deps.chain.joinMatch(key, invite, getProfile());
        saveCheckpoint(joined.covenantId, preJoin);
        openMatch(joined);
      } catch (e) {
        // The genesis UTXO being gone has one meaning here: the seat is no
        // longer up for grabs. Say that, not "sync first".
        if (/game UTXO not found/.test(String((e as any)?.message ?? e)))
          throw new Error(
            "This game is no longer open — someone else took the seat, or the host called it off.",
            { cause: e },
          );
        throw e;
      }
    } else {
      openMatch(invite); // a game in progress or spectating
    }
  });
