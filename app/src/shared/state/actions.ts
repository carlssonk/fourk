import { atom, getDefaultStore } from "jotai";
import * as cov from "../lib/covenant";
import { ensureFunds } from "../lib/dispenser";
import { friendlyError } from "../lib/errors";
import { ZERO_PK } from "../lib/game";
import { SOMPI_PER_KAS, saveCheckpoint, type Match } from "../lib/match";
import { fresherOf } from "../modes/registry";
import { clearInvite, matchesAtom, openMatch } from "./matches";
import { getGameMode, getHostColor, getMatchTiming, getProfile } from "./profile";
import { getRpc } from "./rpc";
import { getWallet } from "./wallet";

const FREE_STAKE = 1n * SOMPI_PER_KAS;
const FEE_MARGIN = SOMPI_PER_KAS / 2n;

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
  }
}

/** The body of newGame, bare so other actions can chain into it (e.g. a
 * kick flows straight into hosting a fresh game). Call inside `runAction`. */
export async function createGame(): Promise<void> {
  startConnecting("Creating your game", [
    "Connecting to the Kaspa network",
    "Topping up your stake",
    "Opening the game on-chain",
  ]);
  const { key } = getWallet();
  const rpc = await getRpc();
  advanceConnecting();
  await ensureFunds(rpc, key, FREE_STAKE + FEE_MARGIN);
  advanceConnecting();
  // Checkpoint the chain from before the open: a join spends the genesis
  // UTXO, and scanning blocks forward from here finds it even if this tab
  // is long gone by then (the watcher persists fresher checkpoints while
  // it runs, this is the floor).
  const preOpen = await cov.chainCheckpoint(rpc);
  const match = await cov.openMatch(rpc, key, FREE_STAKE, getMatchTiming(), getGameMode());
  saveCheckpoint(match.covenantId, preOpen);
  const me = getProfile();
  // My identity and colour choice travel to the opponent inside the link.
  openMatch({
    ...match,
    ...(me.name && { profiles: { p1: me } }),
    ...(getHostColor() === "blue" && { p1Color: "blue" as const }),
  });
}

/** Open a fresh game with the free stake. */
export const newGame = (): Promise<void> => runAction(createGame);

/** Sit down at an invite — or reopen a known game, or spectate. */
export const takeSeat = (invite: Match): Promise<void> =>
  runAction(async () => {
    clearInvite();
    const known = store.get(matchesAtom).find((m) => m.covenantId === invite.covenantId);
    if (known) {
      // A game we're already in: just reopen it, at whichever state is fresher.
      openMatch(fresherOf(known, invite));
      return;
    }
    const { key, myPk } = getWallet();
    if (invite.state.p2 === ZERO_PK && invite.state.p1 !== myPk) {
      startConnecting("Joining the game", [
        "Connecting to the Kaspa network",
        "Topping up your stake",
        "Taking your seat on-chain",
      ]);
      const rpc = await getRpc();
      advanceConnecting();
      await ensureFunds(rpc, key, invite.value + FEE_MARGIN);
      advanceConnecting();
      try {
        // Checkpoint from before the join: the host may act the moment they
        // see us arrive, and without a stored checkpoint the joiner's
        // watcher could never trace that spend (it would just sit stuck).
        const preJoin = await cov.chainCheckpoint(rpc);
        // My profile rides the join tx's payload so P1 learns who sat down.
        const joined = await cov.joinMatch(rpc, key, invite, getProfile());
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
