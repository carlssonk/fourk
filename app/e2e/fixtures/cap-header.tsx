import { useState } from "react";
import { Provider, createStore } from "jotai";
import { createRoot } from "react-dom/client";
import { GameHeader } from "../../src/modules/game/components/GameHeader";
import { useCapClock } from "../../src/modules/game/hooks/useCapClock";
import { rpcClientAtom } from "../../src/shared/state";
import { MODES } from "../../src/shared/modes/registry";
import { FREE_STAKE, type Match } from "../../src/shared/lib/match";

export function mountCapHeader(seconds = 86400, failFirst = false) {
  const store = createStore();
  const started = Date.now();
  let reads = 0;
  store.set(rpcClientAtom, {
    getBlockDagInfo: async () => {
      if (++reads === 1 && failFirst) throw new Error("Temporary connection failure");
      return { virtualDaaScore: 10000n + BigInt(Math.floor((Date.now() - started) / 100)) };
    },
  } as never);
  const match: Match = {
    network: "simnet",
    covenantId: "11".repeat(32),
    txid: "22".repeat(32),
    value: FREE_STAKE * 2n,
    state: {
      p1: "33".repeat(32),
      p2: "44".repeat(32),
      board: new Uint8Array(42),
      moveCount: 0,
      stake: FREE_STAKE,
      moveTimeout: 600,
      deadline: 10000 + seconds * 10,
    },
  };
  function Harness() {
    const [ended, setEnded] = useState(false);
    const [capped, setCapped] = useState(true);
    const [moves, setMoves] = useState(0);
    const capTime = useCapClock(
      {
        ...match,
        txid: String(moves).padStart(64, "0"),
        state: { ...match.state, deadline: capped ? match.state.deadline : 0 },
      },
      !ended,
      "clock",
    );
    return (
      <div className="mx-auto max-w-262">
        <GameHeader
          mode={MODES.fourk2.meta}
          moveTimeout={600}
          busy={false}
          ended={ended}
          capTime={capTime}
          staked={false}
          onHome={() => {}}
        />
        <button onClick={() => setEnded(true)}>End game</button>
        <button onClick={() => setCapped(false)}>Remove limit</button>
        <button onClick={() => setMoves((n) => n + 1)}>Next move</button>
        <output data-testid="cap-reads">{reads}</output>
      </div>
    );
  }
  const container = document.createElement("div");
  container.className = "fixed inset-0 z-50 overflow-auto bg-bg p-4";
  document.body.append(container);
  createRoot(container).render(
    <Provider store={store}>
      <Harness />
    </Provider>,
  );
}
