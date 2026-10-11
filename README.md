# fourk — Connect Four as a Kaspa covenant

Three layers, one rulebook:

- `src/` — TypeScript reference implementation of the transition system, the
  single source of truth for the rules: classic (`src/rules.ts`) and the
  shared-deadline Fourk rules (`src/simul-v2/`, built on the round rules in
  `src/simul/`).
- `contracts/fourk.ag` — the Argent covenant, a require-for-require port of
  those rulebooks: four actors, `FourkLobby`/`FourkMatch` and
  `FourkSimulV2Lobby`/`FourkSimulV2`. (The first simultaneous protocol,
  `FourkSimulLobby`/`FourkSimul`, is retired.) Rebuild with
  `argentc build contracts/fourk.ag --out contracts/build` (from the repo
  root, so the artifact's recorded source path stays relative), which
  regenerates `contracts/build/`
  (`sil/*.sil` + `artifact.json`) — the artifacts the harness, the wasm
  crate, and the app all consume. (An earlier hand-ported Silverscript
  covenant, `fourk.sil`, is retired — see `docs/adr/0001`.)
- `harness/` — Rust integration tests that execute the *compiled contract*
  against the real rusty-kaspa script engine with real Schnorr signatures and
  covenant bindings (KIP-20). This is the suite that audits the machine that
  will actually hold money.
- `test/vectors/differential.json` — what keeps the two hand-kept sources
  (the TS rulebooks and `fourk.ag`) from drifting apart. A seeded generator
  (`test/differential/generate.ts`) walks random games through each
  rulebook, attempts every door from the states it visits (every signer,
  both sides of every clock boundary), and records each attempt as a spend
  with the TS verdict; mutated successors and wrong-player payouts are
  recorded as spends the TS refuses. `wasm/tests/differential.rs` replays
  the file through the browser's transaction builder on the real engine and
  requires the same verdict, with refusals coming from the script itself.
  `pnpm test` fails if the file is stale; regenerate with `pnpm vectors`.
- `wasm/` — `fourk-wasm`: a wasm-bindgen crate embedding the contract and
  exposing two things: an actor state → script public key (addresses) and a
  transaction builder. The app describes every covenant spend as a JSON spec
  (inputs, outputs, entry arguments); the crate signs it, assembles it, and
  executes every input through the real script engine via argent-runtime's
  `TxBuilder` — the same builder the harness drives — so a malformed spend
  fails in the browser with the engine's reason, and compute budgets are
  measured rather than declared (`docs/adr/0002`).
- `app/` — the React UI (Vite): "free mode" by default — a player's key is
  created invisibly, seats are funded automatically by the drip service, and
  games are shared as invite links; staked matches and account management
  (recovery-phrase sign-in, add funds, cash out) speak strictly web2
  vocabulary. Transactions are built and signed in the browser via the
  kaspa wasm SDK + fourk-wasm; invite links carry a compact binary share
  code in the `#g=` fragment, and matches are stored as JSON records
  (`app/src/shared/lib/match.ts`).
- `contracts/drip.sil` — the on-chain dispenser: a 63-byte stateless covenant
  that funds fresh player seats permissionlessly. Claims are UNSIGNED spends
  (fee paid out of the drip), so an empty wallet can claim; the address never
  changes, refills are plain sends to it, `this.ageDaa` rate-limits each lane,
  and a single-input rule blocks lane-aggregation draining. Free mode now
  has no backend at all.
- `faucet/` — `fund-dispenser.mjs` refills the dispenser (the only ongoing
  operational task free mode has).

Root scripts are the one entry point:

```
pnpm check            # types (root + app), the TS suites, app lint
pnpm test             # TS reference: adversarial + property tests, vector freshness
pnpm vectors          # regenerate test/vectors/ after a rules change
pnpm test:covenant    # harness + wasm: compiled covenant vs the real engine, the vectors
pnpm test:live        # live e2e suites on a throwaway local chain (localnet/live.sh)
pnpm build:wasm       # rebuild wasm/pkg after a contract or builder change
```

`pnpm test:live` needs a `kaspad` built at the pinned rusty-kaspa revision
(the command is at the top of the script); it starts the node on a fresh
data dir, mines, funds the faucet key, runs `app/e2e/*-live.test.ts`, and
tears everything down. CI runs it too.

Every toolchain dependency is git-pinned, so a clean clone builds without
sibling checkouts: the [Argent](https://github.com/argent-lang/argent)
runtime (`argent-runtime`, which drives `contracts/fourk.ag`'s committed
artifact in both the harness and the wasm crate),
[Silverscript](https://github.com/kaspanet/silverscript) v1.0.0 (which
compiles `contracts/drip.sil`), and rusty-kaspa (`a41a333`, v2.0.1 plus eight
commits; public testnet-10 runs v2.1.0, whose consensus, script engine, mass
and fee rules are unchanged for everything fourk uses) are
pinned in `harness/Cargo.toml` and `wasm/Cargo.toml` to the exact revisions
argent's own workspace pins — the three must stay equal because
`argent-runtime` re-exports types from the other two. The compiler comes
from the same revision:

```
cargo install --git https://github.com/argent-lang/argent \
  --rev 867b080b973f93d75c4b7ca8ce06950a963accbb argent   # installs argentc
```

The prebuilt browser artifacts are committed so the app builds with no Rust
toolchain at all: `wasm/pkg/` (fourk-wasm; rebuild with
`wasm-pack build --target web --release` in `wasm/` after any contract
change) and `vendor/kaspa-wasm/` (the kaspa SDK web build — see its
VENDOR.md for provenance). `cd app && pnpm install && pnpm start` is the
whole setup.

## Design

One covenant singleton per match (`#[covenant.singleton(mode = transition, termination = allowed)]`),
state in the P2SH redeem-script preimage, eight classic entrypoints:

| entrypoint      | phase   | effect |
|-----------------|---------|--------|
| `join`          | open    | P2 adds matching stake + pubkey; output value must be `2 * stake`; re-checks the genesis gates below |
| `cancel`        | open    | P1 reclaims stake; no deadline needed (a racing join simply orphans it) |
| `dissolve`      | playing, move 0 | either player unwinds an unstarted match; pinned refunds; the joiner's exit waits out one move clock |
| `move`          | playing | drop a disc: your turn, column in range, column not full — the whole rulebook |
| `winning_move`  | playing | `move` + win witness; terminal, pays mover the pot |
| `claim_draw`    | playing | move count = 42; splits pot; permissionless crank |
| `claim_forfeit` | playing | `this.ageDaa >= move_timeout`; waiting player takes the pot |
| `sudden_death`  | playing | `tx.daa >= deadline` and one move clock of age; pays the waiting player (an unmoved or full board splits); permissionless crank — the guaranteed exit |

**Join-time genesis gates** (a genesis violating them is simply unjoinable):
`MIN_MOVE_TIMEOUT <= move_timeout <= MAX_MOVE_TIMEOUT` (a near-instant clock
is a trap, a decades-long one a hostage lock), and a **mandatory** deadline in
`(0, DEADLINE_LIMIT)` — `sudden_death` is the one permissionless door, so a
capless match could strand the pot forever if both players vanished, and a
deadline at the consensus lock-time threshold would flip from DAA-score to
unix-ms semantics. What script CANNOT check is that a deadline is still in
the *future* (a locktime proves time passed, never time remaining) — so the
app refuses to take a seat whose remaining cap is spent (`assertJoinableDeadline`),
and the invite screen shows the actual time left. The liveness guarantee —
every reachable state in both rule sets has a permissionless exit that
returns the whole pot to the players — is a property test
(`test/properties.test.ts`, `test/simul.properties.test.ts`).

Key decisions (and why):

- **The winner points at the win; the covenant never scans the board.**
  The witness is `(col, row, dir)` — first cell of the line plus one of four
  directions. Bent or non-contiguous lines are unrepresentable; verification is
  a bounds check and four cell comparisons. `test/properties.test.ts` proves
  the scheme equivalent to the naive 69-line scanner (the oracle) over random
  reachable states, including exhaustive witness-space sweeps on winless boards.
- **Win claims are merged into the move** (`winning_move`), so a completed win
  can never sit unclaimed while the opponent races the board toward a draw.
  Consequence, tested and documented: a player who declines to claim on every
  remaining turn can lose the win to the move-42 draw. Their choice.
- **No per-move deadline in state.** Every transition creates a fresh UTXO, so
  `this.ageDaa` *is* "time since the last move" and resets automatically. Forfeit
  is `require(this.ageDaa >= move_timeout)`, the clock chosen at creation
  and bounded at join (DAA blocks; ~10/s on mainnet). The one absolute time
  in state is the whole-game `deadline`.
- **No turn or phase fields either.** Turn = `move_count & 1` (P1 opens);
  phase = which actor holds the UTXO (`FourkLobby` is open, `FourkMatch` is
  live). Match state is just `p1 | p2 | board[42] | move_count |
  move_timeout | deadline`; the stake is the UTXO's value (see the mapping
  below; the TS's canonical layout is in `src/state.ts`).
- **Board is `byte[42]`, column-major, row 0 at the bottom** — a column is one
  contiguous 6-byte slice, so the gravity/height check is a short unrolled scan.
  No bitboards: bitwise ops are covenant-gated in Silverscript and the witness
  design makes them unnecessary.

## App architecture: game modes

The app is organized around a per-mode module architecture
(`app/src/shared/modes/`): each rule set implements one `GameMode` interface
— script/address derivation, selector tables, successor enumeration, spend
re-derivation, progress/turn semantics, a React-free view-model (status,
seats, board props), automatic duties (autopilot actions), player actions,
and ending vocabulary. `lib/engine.ts` is the mode-free transaction engine
(the four door shapes: genesis, continuation, signed terminal, pinned
split); `lib/covenant.ts` is the thin app-facing facade; `modes/registry.ts`
is the only module that knows all modes. Adding a mode = a new folder +
a registry entry + its wire-format arms (share-code mode byte + JSON
fields in `modes/wire.ts` / the codecs).

## Fourk mode — simultaneous play (the default)

The signature mode, and the default for new games ("classic" alternating
play stays selectable): each round both players seal a column pick as
`blake2b(playerByte || colByte || salt32)`, then both reveal, and the second reveal drops
BOTH discs in one transition. Same-column picks stack, with the round's
priority player (`round % 2`, 0 = p1) underneath — on a column's last free
slot the non-priority disc vanishes. A commitment to an already-full column
can never be revealed; its owner loses through the timeout door.

New games run on shared picking deadlines (`src/simul-v2/`, the
`FourkSimulV2Lobby`/`FourkSimulV2` pair, the app's `fourk2` mode): both
players' picks in a round must be accepted on-chain by one cutoff derived
from the round-start output's acceptance score, the first round refunds
instead of forfeiting, and lateness is read off acceptance scores rather
than UTXO age. The design, its timing facts and its verification are in
`docs/fourk-shared-deadlines.md`.

The round rules underneath: reference in `src/simul/` (state + rules, same
pure-function contract), extended by `src/simul-v2/`; covenant as the
`FourkSimulV2Lobby` (join/cancel) and `FourkSimulV2` actors, whose doors are
`dissolve`, `commit`, `reveal`, `resolve`, `claim_win`, `claim_split`,
`claim_draw`, `claim_timeout`, `split_timeout`, `sudden_death` and
`sweep_win`. (A first protocol without shared deadlines, the
`FourkSimulLobby`/`FourkSimul` pair, is retired: it let a joiner's lone
first-round pick forfeit an absent host.)

Design notes, mirroring the classic decisions:

- **Sub-phase is derived, never stored.** One commitment slot per player
  (all-zeros = none) and one reveal slot (0 = none, else column + 1); the
  first reveal zeroes the revealer's commitment slot, so slot contents alone
  name the phase. The second reveal never stores — it resolves in-transition.
- **The resolver need not be the winner**, so win claims are keyed to the
  LINE's owner: the witness's first cell names the color, whose key must
  sign `claim_win`. And because the covenant cannot prove a line's ABSENCE
  (no board scan, by design), **`claim_win` is not terminal — it opens a
  challenge window**: the pot parks in a pending successor (`pending_win`
  in state, round slots zeroed) for one move clock. `claim_split` — both
  witnesses, permissionless, computable from the public board by anyone —
  stays legal on pending states and converts a hidden double win into the
  fair split at leisure; `sweep_win` pays the pending winner once the
  window lapses, its sequence lock enforced by consensus itself. The old
  edge (greedy one-line `claim_win` racing honest `claim_split` in the
  mempool — a race a bot always wins) is gone; the round doors, the draw,
  and both timeout doors gate on `pending_win == 0` (`split_timeout`
  especially: a pending state is slot-empty and symmetric-shaped, and
  without its gate the sweep clock would double as a permissionless
  half-pot steal). `sudden_death` alone stays ungated — the liveness exit
  outranks the window.
- **Two timeout doors.** One-sided lateness (a lone committer or lone
  revealer waiting on the opponent) pays the compliant player the pot
  (`claim_timeout` — this is also what punishes peek-then-stall and the
  unrevealable full-column commitment); symmetric silence splits it
  (`split_timeout`, permissionless). Same `this.ageDaa` clock as classic.
- **The salt lives in the browser** (`localStorage`, written before the
  commit broadcast). It is secret, so it cannot ride the share code: a pick
  sealed in one browser cannot be revealed from another — the timeout doors
  settle that, and the UI warns.
- **Sync**: reveal- and resolve-phase successors are enumerable (≤14 / ≤7
  addresses); a commit successor embeds the opponent's unpredictable hash
  and gets the join treatment. When the game UTXO is gone the client
  replays the chain from a checkpoint (`followChain` in
  `app/src/shared/lib/covenant.ts`): every *accepted* spend of the lineage
  in order, each re-derived and checked against the address the spending
  transaction paid. Only accepted spends count (a DAG can hold the losing
  side of a double spend in a block too), and a successor that was already
  spent onward (an opponent's commit and their reveal a second later) is
  followed, not lost.
- **Compute budget**: measured, not declared — the builder executes every
  input and commits the budget the engine actually charged. Fourk-mode
  continuations are the dear ones (~15 units for join: every continuation
  rebuilds and hashes the ~7.4 KB `FourkSimulV2` successor template
  in-script) against ~11 for classic.

## TS reference ↔ covenant mapping

The covenant state deviates from the TS reference in two deliberate ways
(the field-for-field correspondence itself is what the differential vectors
check):

- **`stake` is not a covenant state field.** The UTXO value *is* the pot: join
  enforces doubling (`output == 2 * input`), moves enforce preservation, and
  the terminal doors spend it. Fees therefore ride on a second wallet input,
  which also keeps storage mass at zero per KIP-9.
- **`phase` is not a field: it is the actor.** The TS derives it from
  `p2 == ZERO_PK`; the covenant holds an open seat as a lobby actor and a
  joined match as a match actor, so entering a door on the wrong phase is
  impossible by construction. `join` builds the match's genesis state itself
  and re-checks the lobby's gates, so a malformed genesis is simply
  unjoinable.

Payout enforcement is asymmetric on purpose: the permissionless doors
(`claim_draw`, `sudden_death`, and in Fourk `claim_split` and
`split_timeout`) and `dissolve`, whose signer refunds the other player too,
pin their outputs to the players' keys and pay the fee out of the pot,
capped by `MAX_FEE`; `cancel`, `winning_move`, `claim_forfeit`,
`claim_timeout` and `sweep_win` are signed by the party the whole pot
belongs to, so they direct funds freely like any wallet spend (no forced
address reuse). Every terminal door requires zero authorized covenant
outputs, ending the KIP-20 lineage cleanly.

Two engine facts learned the hard way, for future porters:

- `byte[N](0)` lowers to `OpNum2Bin`, which the engine caps at 8-byte targets —
  build wide zero constants from hex literals instead.
- The debugger's `.test.json` runner advertises 32-byte-secret auto-signing,
  but no signing is implemented in that path; real-signature tests need the
  Rust harness (`chess_apps_tests.rs` pattern), which is what `harness/` does.

## Playing on testnet-10

The app is the front-end: `cd app && pnpm install && pnpm start`. It uses the
public node resolver by default; a pinned node (Toccata-active testnet-10 with
`--utxoindex`) can be set via `VITE_NODE_URL` in `app/.env.local`.

Transaction shapes and conventions (`app/src/shared/lib/engine.ts` builds
them, `app/src/shared/lib/covenant.ts` is the facade):

- All transactions are **v1** with per-input compute budgets, measured by
  executing each input before submission.
- Opening a game derives the covenant id from the funding outpoint via
  `populate_genesis_covenants`; the id is the match's stable handle forever.
- Continuations (join, move, commit, reveal, resolve, claim_win) preserve
  the pot exactly (join doubles it), so fees ride on a wallet funding input
  with change; the terminal doors pay fees out of the pot.
- Sync exploits that successors are mostly enumerable: the app computes the
  P2SH address of every legal next state (≤ 7 in classic) and polls
  `getUtxosByAddresses`, adopting whichever carries the match's covenant id.
  What it cannot enumerate (a join's unknown pubkey, a Fourk commit's
  unknown hash) it recovers by tracing the spending transaction from a
  saved chain checkpoint and re-deriving the successor from its pushes.
- In classic, a drop that completes four in a row is always sent as
  `winning_move`, never as a plain move — the guard against the "unclaimed
  win lost to the draw" edge in the design.
- Node rejections are read by one classifier (`classifyFailure` in
  `app/src/shared/lib/errors.ts`): a spent input means resync and rebuild,
  an unreached lock means wait, a lost connection means retry; the node
  error texts it relies on are pinned in `app/test/failures.test.ts`.

## The React app

Fully client-side; anyone can host it and any two browsers can play.

```
cd app
pnpm install
pnpm start         # or: pnpm build && pnpm preview
```

Both wasm packages are committed (`wasm/pkg/`, `vendor/kaspa-wasm/`), so no
Rust toolchain is needed; after a contract or builder change, rebuild
`wasm/pkg` with `pnpm build:wasm`.

Both the app and the drip service default to the **public node resolver** —
no local node needed (public testnet-10 nodes run v2.1.0, synced,
Toccata-active, utxoindex-enabled, and serve wss so browsers connect from
anywhere; `app/scripts/check-dist.mjs` proves a production build reaches
one). A local node still works via `VITE_NODE_URL` in
`app/.env.local` or `KASPA_RPC_URL`.

Fund the on-chain dispenser (fresh seats then fund themselves invisibly —
no server):

```
cd faucet && node fund-dispenser.mjs <funded-keyfile> [lanes] [tkas-per-lane]
```

Each lane drips 10 TKAS at most once per ~2 minutes; the app claims from the
oldest eligible lane with an unsigned covenant spend. Refill any time by
sending TKAS to the dispenser address (printed by fund-dispenser.mjs).

Free-mode flow: **New game** → send the invite link →
opponent clicks it and takes their seat (their key and funds materialize
automatically) → play. The app watches the chain for joins and moves,
auto-claims wins on winning drops, settles full boards as draws by itself,
classifies endings from the spending transaction's entrypoint selector, and
offers "opponent gone" timeout claims with a countdown. Stakes in free mode
are a fixed 1 TKAS, deliberately invisible.

## Accounts and staked play

The web3 layer stays backstage even with real money in play — the UI speaks
only "account / balance / add funds / cash out / recovery phrase / pot":

- **Two kinds of key, deliberately kept apart** (`app/src/shared/state/wallet.ts`,
  stored as `fourk.account` v3). The **guest** key is the original invisible
  seat: created on first visit, never shown, never given a phrase, funded
  entirely by the drip dispenser, and it signs free games forever. The
  **owned** key is one the player deliberately created or imported; it is
  the only key with a balance on screen and the only one that can stake a
  game. A player who never leaves free mode never sees a wallet — no
  balance, no addresses, no amounts anywhere.

  That split is not just presentation. Before it, a few free games would
  accumulate dispenser float that staked play would then happily accept as
  the player's own balance — on mainnet, wagering the operator's faucet.
  Now dispenser money can never fund a stake or leave as a cash-out:
  `signingWallet({ staked })` picks the key, and the guest key is never
  swept, never shown, and never cashed out.
- **An account IS its phrase.** Creating one shows 12 BIP-39 words behind a
  required acknowledgement; the key derives through the SDK's standard Kaspa
  path (m/44'/111111'/0', receive 0) on use and is never stored, so a phrase
  written down here restores the same funds in Kaspium/Kasware and vice versa
  (`app/src/shared/lib/mnemonic.ts`, pinned by a derivation vector in
  `app/test/account.test.ts`). Sign-in takes a phrase and nothing else — one
  kind of secret, one thing to write down. The phrase itself is kept in this
  browser's storage (persistence is requested so it is not evicted), which
  is why the test build's sign-in screen says to use only phrases made here,
  never one that holds real KAS.

  Creating and signing in are the *same* operation: `adoptAccount(phrase)`
  makes the phrase the active account, and that is the only way an account
  is ever set. Switching moves no money: every stored account stays listed,
  keeps its funds and can still sign its own games. A new phrase is
  generated on the acknowledgement screen and stored nowhere until the
  player confirms it, so abandoning that screen — backdrop, refresh, closed
  tab — leaves nothing behind rather than an account whose phrase was never
  read.
- **Staked matches.** An account holder picks a stake (or Free). Whether a
  game is staked is *read off the covenant's own stake* — `isStaked(m)` is
  `state.stake !== FREE_STAKE` — never claimed by the invite: a share code is
  written by whoever sends it, and a forged "this one's free" link would
  otherwise spend dispenser funds on a real wager. The stake, by contrast, is
  chain-enforced (lie about it and the node rejects the join). `FREE_STAKE`
  is deliberately one sompi off a round number so no stake a player can pick
  can collide with it, and a test pins that against `STAKE_PRESETS`. Staked
  seats are funded from the player's own balance and NEVER touch the
  dispenser (`ensureFunds(..., { staked })` throws a friendly "add funds"
  error instead); the pot shows on the invite, over the board, and in the
  verdict.
- **Money UI.** Guests get an avatar chip that offers an account. Account
  holders get the balance (a 10s poll plus a refresh on focus and after every
  action — one address is too cheap to be worth a subscription that dies with
  the socket) and the panel: deposit address, cash-out (`engine.sendTo` —
  exact amount, or a full sweep with the fee taken from the sent amount),
  backup, and sign-in. Cash-out's Max holds back the 0.5 KAS fee margin
  while one of *that account's* games is unfinished (free games don't count
  — the guest key pays their fees).

Note on the network axis: the dispenser is testnet infrastructure, so free
mode — and with it the guest tier — is what a mainnet deployment loses. Stakes
are gated by tier, not by network, so staked play stays testable on simnet and
testnet.

`fourk-wasm` embeds the same argentc artifact the harness executes and builds
transactions through the same `TxBuilder`, so what a browser submits has
already run through the script engine locally.

## Status / next steps

- [x] TS reference + adversarial property tests
- [x] Silverscript port, compiled and engine-verified (since retired for
  the Argent contract, see below)
- [x] Deployment CLI: v1 covenant transactions, genesis binding, chain
  sync/watcher, live on testnet-10 (since retired; the app does all of it)
- [x] React UI: client-side covenant compilation (fourk-wasm), tx build/sign
  in browser, lobby/board/watcher
- [x] Fourk mode (simultaneous commit-reveal play): reference in
  `src/simul/`, share-code mode section, salt store, round UI (its first
  covenant pair has since been replaced by V2, below)
- [x] Production-readiness hardening pass: mandatory join-time deadline +
  clock bounds (a hostile invite can no longer trap or hostage a stake, and
  no pot can be stranded forever — liveness is a property test), the
  `claim_win` challenge window (the double-win mempool race is gone),
  invite/share-code validation (network binding, value↔stake, timing
  bounds), account-record salvage-not-destroy, evidence-based watcher and
  reset detection, multi-input + all-door-lineage harness
  coverage, CI for the TS side, security headers + deploy notes
  (`app/DEPLOY.md`), dispenser status + runbook (`faucet/RUNBOOK.md`)
- [x] Single covenant source: the hand-ported `fourk.sil` and its parallel
  suite retired in favor of the Argent contract (`docs/adr/0001`);
  genesis-gate constants pinned across TS/.ag/harness by a cross-source test
- [x] Fourk V2, shared picking deadlines (the default for new games):
  `src/simul-v2/`, the `FourkSimulV2*` actors, harness suite, the `fourk2`
  app mode; verified on a local simnet node (`app/e2e/simul-v2-live.test.ts`,
  `docs/fourk-shared-deadlines.md`)
- [x] Differential vectors: the TS rulebooks and the compiled covenant
  agree door for door (`test/vectors/`, `wasm/tests/differential.rs`)
- [x] Live simnet suites in one command and in CI (`localnet/live.sh`),
  including exact DAA boundaries and on-node races with the miner held
  (`app/e2e/simul-v2-edges-live.test.ts`), and the browser suite against the
  same throwaway chain (`localnet/browser.sh`)
- [x] Release-candidate hardening: production bundles that reach a node
  (checked in CI), builds that refuse local-only settings, chain replay
  through accepted spends only, settlements recorded only once the chain
  took them, duties followed for every unfinished game in the background,
  fees clamped to the covenant ceiling, classic's cap no longer splits an
  owed forfeit, exact-drip dispenser claims
- [ ] Live browser-vs-browser game on testnet-10 through every terminal path
- [x] Browser transactions built by argent-runtime's `TxBuilder` inside
  fourk-wasm (`docs/adr/0002`): engine-verified before submission, budgets
  measured, spend classification by entry dispatch tag; every toolchain
  dependency git-pinned and the Rust suites in CI
- [ ] External audit of the compiler lowering before mainnet funds.
