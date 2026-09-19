import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AccountChip, AccountPanel } from "@modules/account";
import { Game } from "@modules/game";
import { Home } from "@modules/home";
import { ConfirmDialog } from "@shared/components/ConfirmDialog";
import { ConnectingScreen } from "@shared/components/ConnectingScreen";
import {
  accountPanelAtom,
  clearError,
  clearNetworkReset,
  connectingAtom,
  currentMatchAtom,
  errorAtom,
  networkResetAtom,
  reconnectingAtom,
  rpcFailuresAtom,
} from "@shared/state";

/** Notice with an explicit × — the banner itself stays inert so the text
 * can be selected (error messages get pasted into bug reports) and a stray
 * click can't eat a message before it's read. */
const Banner = ({
  tone,
  onDismiss,
  children,
}: {
  tone: "red" | "accent";
  onDismiss: () => void;
  children: React.ReactNode;
}) => (
  <div
    role={tone === "red" ? "alert" : "status"}
    className={`mx-auto mb-4 flex max-w-175 items-start gap-3 rounded-lg border px-3.5 py-2.5 ${
      tone === "red" ? "border-red bg-red/10" : "border-accent bg-accent/10"
    }`}
  >
    <p className="flex-1">{children}</p>
    <button
      type="button"
      aria-label="dismiss"
      onClick={onDismiss}
      className="cursor-pointer text-lg leading-none text-dim hover:text-ink"
    >
      ×
    </button>
  </div>
);

export default function App() {
  const current = useAtomValue(currentMatchAtom);
  const error = useAtomValue(errorAtom);
  const connecting = useAtomValue(connectingAtom);
  const accountAvailable = !current && !connecting;
  const setAccountPanel = useSetAtom(accountPanelAtom);
  useEffect(() => {
    if (!accountAvailable) setAccountPanel(null);
  }, [accountAvailable, setAccountPanel]);
  const reconnecting = useAtomValue(reconnectingAtom);
  const networkReset = useAtomValue(networkResetAtom);
  // Never connected at all (vs. reconnecting, which means a live session's
  // socket dropped). Two strikes before the banner: one resolver timeout is
  // routine, and the backoff loop is already retrying underneath.
  const offline = useAtomValue(rpcFailuresAtom) >= 2;

  return (
    <div className={`mx-auto max-w-270 p-4 ${connecting ? "flex min-h-dvh flex-col" : ""}`}>
      {/* In the flow, not floating: the game screen puts a seat panel in the
       * top-right corner, and a fixed chip would sit on top of it. */}
      <header
        className={
          current && !connecting && !reconnecting
            ? "hidden"
            : "mb-2 flex h-8 shrink-0 items-center justify-end gap-2"
        }
      >
        {reconnecting && (
          <div className="rounded-full border border-accent bg-panel/60 px-3 py-1 text-sm text-accent backdrop-blur-xs">
            reconnecting…
          </div>
        )}
        {accountAvailable && <AccountChip />}
      </header>
      {accountAvailable && <AccountPanel />}
      <ConfirmDialog />
      <main className={`mx-auto ${connecting ? "flex w-full flex-1 flex-col" : ""}`}>
        {offline && (
          <div className="mx-auto mb-4 max-w-175 rounded-lg border border-red bg-red/10 px-3.5 py-2.5">
            Connection lost. Retrying automatically. Check your internet connection if this
            continues.
          </div>
        )}
        {networkReset && (
          <Banner tone="accent" onDismiss={clearNetworkReset}>
            The test network was reset. Previous games and balances are no longer available. New
            games work normally.
          </Banner>
        )}
        {error && (
          <Banner tone="red" onDismiss={clearError}>
            {error}
          </Banner>
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
