import { useAtomValue } from "jotai";
import { AccountChip, AccountPanel } from "@modules/account";
import { Game } from "@modules/game";
import { Home } from "@modules/home";
import { ConfirmDialog } from "@shared/components/ConfirmDialog";
import { ConnectingScreen } from "@shared/components/ConnectingScreen";
import {
  clearError,
  clearNetworkReset,
  connectingAtom,
  currentMatchAtom,
  errorAtom,
  networkResetAtom,
  reconnectingAtom,
  rpcFailuresAtom,
} from "@shared/state";

export default function App() {
  const current = useAtomValue(currentMatchAtom);
  const error = useAtomValue(errorAtom);
  const connecting = useAtomValue(connectingAtom);
  const reconnecting = useAtomValue(reconnectingAtom);
  const networkReset = useAtomValue(networkResetAtom);
  // Never connected at all (vs. reconnecting, which means a live session's
  // socket dropped). Two strikes before the banner: one resolver timeout is
  // routine, and the backoff loop is already retrying underneath.
  const offline = useAtomValue(rpcFailuresAtom) >= 2;

  return (
    <div className="mx-auto max-w-270 p-4">
      {/* In the flow, not floating: the game screen puts a seat panel in the
       * top-right corner, and a fixed chip would sit on top of it. */}
      <header className="mb-2 flex h-8 items-center justify-end gap-2">
        {reconnecting && (
          <div className="rounded-full border border-accent bg-panel/60 px-3 py-1 text-sm text-accent backdrop-blur-xs">
            reconnecting…
          </div>
        )}
        <AccountChip />
      </header>
      <AccountPanel />
      <ConfirmDialog />
      <main className="mx-auto">
        {offline && (
          <div className="mx-auto mb-4 max-w-175 rounded-lg border border-red bg-red/10 px-3.5 py-2.5">
            Can't reach the Kaspa network — retrying automatically. Check your connection; games
            resume on their own once it's back.
          </div>
        )}
        {networkReset && (
          <div
            className="mx-auto mb-4 max-w-175 cursor-pointer rounded-lg border border-accent bg-accent/10 px-3.5 py-2.5"
            onClick={clearNetworkReset}
          >
            The test network was reset — games and balances from before it are gone. New games work
            normally.
          </div>
        )}
        {error && (
          <div
            className="mx-auto mb-4 max-w-175 cursor-pointer rounded-lg border border-red bg-red/10 px-3.5 py-2.5"
            onClick={clearError}
          >
            {error}
          </div>
        )}
        {connecting ? (
          <ConnectingScreen connecting={connecting} />
        ) : current ? (
          // Keyed per match: switching games directly (e.g. a pasted link)
          // must reset per-game state like results and watch checkpoints.
          <Game key={current.covenantId} match={current} />
        ) : (
          <Home />
        )}
      </main>
    </div>
  );
}
