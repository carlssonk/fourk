# CONTEXT.md — domain glossary

Names the code, reviews, and design discussions use with exact meaning. Add a
term when a module gets named after it; sharpen a term here the moment a
conversation reveals it was fuzzy.

## App / state layer

- **ChainOps** — the app-side interface to the chain: balances, transfers,
  opening and joining matches, funding seats. The seam behind the match
  actions (`createGame`, `takeSeat`). Two adapters: the
  covenant facade bound to the live RPC (prod) and an in-memory ledger
  (tests). The adapter owns the connection — `connect()` is an explicit
  step (it is what the "Connecting to the Kaspa network" UI step ticks on);
  no `RpcClient` appears in the interface. Distinct from **ModeChainSurface**.

- **AccountOps** — the account-store surface behind the same seam: which key
  signs what (`hasOwnedAccount`, `signingWallet`, `matchWallet`). Account
  creation and switching stay outside it: `adoptAccount` ends in a page
  reload and is called straight from the account UI — no match action ever
  adopts, so the seam doesn't carry it.

- **ModeChainSurface** — a game mode's chain surface (`modes/types.ts`):
  which actor holds a snapshot and its state fields (`actorOf`/`stateOf`),
  successor enumeration, spend re-derivation. Per-mode; not the same thing
  as ChainOps, which is mode-agnostic wallet/match plumbing.

- **Transaction spec** — the JSON description of one covenant spend
  (`TxSpec` in `lib/engine.ts`: inputs, outputs, ABI-ordered entry
  arguments, signer indices) that `fourk-wasm`'s builder turns into a
  signed, engine-verified transaction. The app never assembles scripts; a
  door is a spec (`docs/adr/0002`).

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

## Quick Match

- **Quick Match** — pairing two strangers who both pressed the button, with
  no invite link ([ADR 0003](docs/adr/0003-quick-match-through-a-keyless-matchmaker.md)).
  Client loop in `state/quickMatch.ts`; the opposite of a private game,
  whose host shares a link.

- **Matchmaker** — the `/match` routes in the sweeper process
  (`app/sweeper/match.ts`). Pairs seekers, picks the host, and forwards the
  host's share code once its node holds that lobby. Holds no keys and is
  not trusted: the joiner re-checks everything it is handed. Reached through
  **MatchmakerOps** (`state/deps.ts`), the seam the loop takes beside
  ChainOps and AccountOps as **QuickMatchDeps**; `lib/matchmaker.ts` is its
  HTTP adapter.

- **Ticket** — one seeker's place in the matchmaker's queue. Polling it is
  the seeker's presence; a ticket that goes quiet is dropped and its partner
  requeued.

- **Quick Match terms** — what a lobby must be for the queue it was handed
  to: right network and mode, free stake, the preset clock
  (`isQuickMatchTerms`, `lib/quickMatch.ts`), plus each mode's own markings
  (`GameMode.quickLobbyMarks`). The game limit is an absolute score, so the
  joiner holds it to the preset's cap at join, both ways.

- **quick flag** — Fourk V2 covenant state (`quick`, 0 or 1), set by the
  host at open: consensus state, carried in share codes, the same on every
  device. Its one effect is that `dissolve` lets the joiner leave at once.
  Not to be confused with the **paired mark**.

- **Paired mark** — `Match.paired`, our own record's note that Quick Match
  paired a game. Never wire state. The only marker Classic has (it has no
  covenant flag), so a Classic joiner still waits one clock to leave. Ask a
  game which it is through `GameMode.isQuickMatched`, never either field
  directly.
