import { atom, getDefaultStore } from "jotai";
import { friendlyError } from "../lib/errors";
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
  store.set(errorAtom, friendlyError((e as any)?.message ?? String(e)));
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

/** Below this, moving the balance costs more in fees than it rescues. */
const SWEEP_FLOOR = SOMPI_PER_KAS / 20n;

/**
 * Switch to the account behind `phrase`, moving the current account's
 * balance across first.
 *
 * The move happens here, in the open, because adopting the new phrase drops
 * the only reference to the old key: there is no drawer of retired keys to
 * come back to. A failed transfer therefore aborts the switch — better to
 * stay signed in and retry than to strand funds on a key we've forgotten.
 *
 * Returns false if it's already the active account (no reload).
 */
export async function switchAccount(phrase: string, deps: Deps = realDeps): Promise<boolean> {
  const outgoing = deps.account.ownedWallet();
  const incoming = deps.account.phraseWallet(phrase);
  if (outgoing?.myPk === incoming.myPk) return false;
  // If this browser can't persist the new account, find out BEFORE the
  // balance moves toward it — a sweep followed by a failed save would leave
  // the funds on a phrase the app immediately forgot it was adopting.
  deps.account.assertStorageWritable();
  if (outgoing) {
    const balance = await deps.chain.walletBalance(outgoing.key);
    if (balance >= SWEEP_FLOOR) {
      try {
        await deps.chain.sendTo(outgoing.key, incoming.key, "all");
      } catch (e) {
        // A throw here does NOT mean the sweep didn't land — a dropped
        // socket can eat the response after the node accepted the tx. Ask
        // the chain what actually happened rather than trusting the error:
        // the outgoing balance dropping is the sweep in flight.
        let after: bigint | null = null;
        for (let attempt = 0; attempt < 3 && after === null; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            after = await deps.chain.walletBalance(outgoing.key);
          } catch {
            /* still unreachable — try again */
          }
        }
        if (after === null) throw new Error("MOVE_UNCERTAIN", { cause: e });
        if (after >= balance) throw new Error("MOVE_FAILED", { cause: e });
        // Balance dropped: the sweep landed — funds are heading to the
        // incoming account, so finishing the switch is the safe direction.
      }
    }
  }
  return deps.account.adoptAccount(phrase); // reloads
}

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
