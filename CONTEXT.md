# CONTEXT.md — domain glossary

Names the code, reviews, and design discussions use with exact meaning. Add a
term when a module gets named after it; sharpen a term here the moment a
conversation reveals it was fuzzy.

## App / state layer

- **ChainOps** — the app-side interface to the chain: balances, transfers,
  opening and joining matches, funding seats. The seam behind the match
  actions (`createGame`, `takeSeat`, `switchAccount`). Two adapters: the
  covenant facade bound to the live RPC (prod) and an in-memory ledger
  (tests). The adapter owns the connection — `connect()` is an explicit
  step (it is what the "Connecting to the Kaspa network" UI step ticks on);
  no `RpcClient` appears in the interface. Distinct from **ModeChainSurface**.

- **AccountOps** — the account-store surface behind the same seam: which key
  signs what (`hasOwnedAccount`, `signingWallet`, `matchWallet`). Account
  creation and switching stay outside it: `adoptAccount` ends in a page
  reload and is called straight from the account UI — no match action ever
  adopts, so the seam doesn't carry it.

- **ModeChainSurface** — a game mode's script/successor surface
  (`modes/types.ts`): state → lock script, successor enumeration, spend
  re-derivation. Per-mode; not the same thing as ChainOps, which is
  mode-agnostic wallet/match plumbing.

## Rules core

- **Door** — one entrypoint of the rulebook (`join`, `move`, `reveal`, …); a
  pure function whose every `req` becomes a contract `require`. The doors ARE
  the interface of `src/rules.ts` / `src/simul/rules.ts`.

- **Shape builder** — the exported successor-shape half of a door
  (`applyReveal`, `applyResolve`, …): guards stay in the door, the field
  mutations live once in the builder. Exists so the fourk engine's
  `successors()` can pose transitions it cannot authorize (it never knows an
  opponent's salt) without re-deriving the field list.

- **Reachable state** — a state producible from a genesis by some legal door
  sequence. `validateReachableState` (src/state.ts) is the one home for
  reachability invariants; every decoder (share code, match.json, canonical
  codec) calls it instead of re-deriving its own checks. The canonical
  fixed-width codec (`STATE_BYTES`) is a contract-layout mirror, not the
  app's wire format — invite links use the compact share-code format.
