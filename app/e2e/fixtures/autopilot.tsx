import { useAtomValue, getDefaultStore } from "jotai";
import { createRoot } from "react-dom/client";
import { useAutopilot } from "../../src/modules/game/hooks/useAutopilot";
import { busyAtom, currentMatchAtom } from "../../src/shared/state";
import { modeOf } from "../../src/shared/modes/registry";

/** Exercise the real hook's failure recovery on a live, unspent test match.
 * The action itself models one rejected payout followed by success. */
export function mountPayoutRetry(failure: "sequence" | "connection" | "schedule" | "age") {
  const match = getDefaultStore().get(currentMatchAtom)!;
  const output = document.createElement("output");
  output.dataset.testid = "payout-retry";
  output.textContent = "waiting";
  document.body.append(output);
  const container = document.createElement("div");
  document.body.append(container);
  let runs = 0;
  let reads = 0;
  const mode = {
    ...modeOf(match),
    autoActions: () => [
      {
        key: "sweep",
        oncePer: "match" as const,
        scheduleMs: async () => {
          if (++reads === 1 && failure === "schedule") throw new Error("WebSocket disconnected");
          if (failure === "age" && reads < 3) return 100;
          return 0;
        },
        run: async () => {
          if (failure === "age" && reads < 3)
            throw new Error("Payout attempted before chain maturity");
          if (++runs === 1 && (failure === "sequence" || failure === "connection")) {
            throw new Error(
              failure === "sequence"
                ? "one of the transaction sequence locks conditions was not met"
                : "WebSocket disconnected",
            );
          }
          return { kind: "finished" as const, message: "settled" };
        },
      },
    ],
  };
  function Harness() {
    const busy = useAtomValue(busyAtom);
    useAutopilot(match, mode, {
      result: null,
      busy,
      finish: (message) => {
        output.textContent = message;
      },
    });
    return null;
  }
  const root = createRoot(container);
  root.render(<Harness />);
  return () => {
    root.unmount();
    output.remove();
    container.remove();
  };
}
