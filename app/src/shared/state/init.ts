/**
 * The state layer's one startup entrypoint. Importing a state module is
 * side-effect-free — timers, cross-tab listeners, and the URL/storage reads
 * all start here, called once from main.tsx after the wasm SDK is up (and
 * never in tests, which import the modules bare and inject fakes).
 */

import { startBalancePolling } from "./balance";
import { initMatches } from "./matches";
import { wireProfileCrossTab } from "./profile";
import { initRpc } from "./rpc";
import { wireAccountCrossTab } from "./wallet";

export function initStateLayer(): void {
  initMatches();
  wireAccountCrossTab();
  wireProfileCrossTab();
  startBalancePolling();
  initRpc();
}
