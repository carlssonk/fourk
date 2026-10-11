import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultOverlay } from "../../src/modules/game/components/ResultOverlay";

export function mountResultOverlay(tone: "win" | "loss") {
  const container = document.createElement("div");
  document.body.append(container);
  function Harness() {
    const [action, setAction] = useState<string | null>(null);
    return action ? (
      <output data-testid="result-action">{action}</output>
    ) : (
      <ResultOverlay
        title={tone === "win" ? "You win!" : "You lose"}
        result={tone === "win" ? "You connected four." : "Your opponent connected four."}
        tone={tone}
        busy={false}
        onPlayAgain={() => setAction("play")}
        onExit={() => setAction("home")}
        onDismiss={() => setAction("board")}
      />
    );
  }
  createRoot(container).render(<Harness />);
}
