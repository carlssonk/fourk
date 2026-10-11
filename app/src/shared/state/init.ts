/**
 * The state layer's one startup entrypoint. Importing a state module is
 * side-effect-free — timers, cross-tab listeners, and the URL/storage reads
 * all start here, called once from main.tsx after the wasm SDK is up (and
 * never in tests, which import the modules bare and inject fakes).
 */

import { startBalancePolling } from "./balance";
import { getDefaultStore } from "jotai";
import { busyAtom, reportError } from "./actions";
import { initMatches } from "./matches";
import { wireProfileCrossTab } from "./profile";
import { initRpc } from "./rpc";
import { hasOwnedAccount, requestPersistentStorage, wireAccountCrossTab } from "./wallet";

export function initStateLayer(): void {
  initMatches(reportError);
  wireAccountCrossTab();
  // Every adopted account lands here after its reload: keep its phrase from
  // being evicted with the rest of the site data.
  if (hasOwnedAccount()) requestPersistentStorage();
  wireProfileCrossTab();
  startBalancePolling();
  initRpc();
  // Leaving mid-action (a stake being placed, a pick being sealed) asks
  // first: the browser's own prompt, no custom copy allowed or needed.
  window.addEventListener("beforeunload", (e) => {
    if (!getDefaultStore().get(busyAtom)) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
