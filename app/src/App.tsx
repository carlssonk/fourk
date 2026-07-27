import { useAtomValue } from "jotai";
import { Game } from "@modules/game";
import { Home } from "@modules/home";
import { ConnectingScreen } from "@shared/components/ConnectingScreen";
import {
  clearError,
  connectingAtom,
  currentMatchAtom,
  errorAtom,
  reconnectingAtom,
} from "@shared/state";

export default function App() {
  const current = useAtomValue(currentMatchAtom);
  const error = useAtomValue(errorAtom);
  const connecting = useAtomValue(connectingAtom);
  const reconnecting = useAtomValue(reconnectingAtom);

  return (
    <div className="mx-auto max-w-270 p-4">
      {reconnecting && (
        <div className="fixed top-3 right-3 z-10 rounded-full border border-accent bg-panel/60 px-3 py-1 text-sm text-accent backdrop-blur-xs">
          reconnecting…
        </div>
      )}
      <main className="mx-auto">
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
