import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@shared/components/ErrorBoundary";
import { initSdk } from "@shared/lib/sdk";
import { getRpc as initRpc, reportError } from "@shared/state";
import App from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason));

initSdk()
  .then(() => {
    initRpc();
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((e) => {
    root.render(
      <div className="mx-auto max-w-160 p-8 text-center">
        <h1 className="mb-2 text-2xl font-bold text-accent">fourk</h1>
        <p>Couldn't load the game engine - check your connection and refresh.</p>
        <p className="mt-2 text-sm text-dim">{String(e)}</p>
      </div>,
    );
  });
