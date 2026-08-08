# fourk — Connect Four as a Kaspa covenant

Three layers, one rulebook:

- `src/` — TypeScript reference implementation of the transition system, the
  single source of truth for the rules.
- `contracts/fourk.sil` — the Silverscript covenant, a require-for-require port
  of `src/rules.ts`. Compiles to ~1.4 KB of script (smaller than the simplest
  chess contract in the silverscript repo). Compile with:
  `silverc contracts/fourk.sil --ctor contracts/genesis_args.json`
- `harness/` — Rust integration tests that execute the *compiled contract*
  against the real rusty-kaspa script engine with real Schnorr signatures and
  covenant bindings (KIP-20). This is the suite that audits the machine that
  will actually hold money.
- `wasm/` — `fourk-wasm`: a small wasm-bindgen crate embedding the contract
  and exposing state → redeem script and entrypoint → signature script, so
  browsers can compile covenant states client-side.
- `app/` — the React UI (Vite): "free mode" by default — a player's key is
  created invisibly, seats are funded automatically by the drip service, and
  games are shared as invite links; staked matches and account management
  (recovery-phrase sign-in, add funds, cash out) speak strictly web2
  vocabulary. Transactions are built and signed in the browser via the
  kaspa wasm SDK + fourk-wasm; invite links carry a compact binary share
  code in the `#g=` fragment, and stored matches use the same JSON schema
  as the CLI's match.json.
- `contracts/drip.sil` — the on-chain dispenser: a 40-byte stateless covenant
  that funds fresh player seats permissionlessly. Claims are UNSIGNED spends
  (fee paid out of the drip), so an empty wallet can claim; the address never
  changes, refills are plain sends to it, `this.age` rate-limits each lane,
  and a single-input rule blocks lane-aggregation draining. Free mode now
  has no backend at all.
- `faucet/` — `fund-dispenser.mjs` refills the dispenser (the only ongoing
  operational task free mode has).

```
npm test                        # TS reference: adversarial + property tests
npm run typecheck
cd harness && cargo test        # compiled covenant vs the real engine
# live e2e vs a local chain (start localnet/run-node.sh + mine.mjs first):
SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run app/e2e/simul-live.test.ts
```

The harness needs the sibling [silverscript](https://github.com/kaspanet/silverscript)
repo checked out at `../silverscript` (path dependency) and pins rusty-kaspa
v2.0.1, matching the silverscript workspace.

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
| `claim_forfeit` | playing | `this.age >= move_timeout`; waiting player takes the pot |
| `sudden_death`  | playing | `tx.time >= deadline`; splits pot; permissionless crank — the guaranteed exit |

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
- **No deadline field in state.** Every transition creates a fresh UTXO, so
  `this.age` *is* "time since the last move" and resets automatically. Forfeit
  is `require(this.age >= MOVE_TIMEOUT_DAA)` with a compile-time constant
  (DAA blocks; ~10/s on mainnet).
- **No turn or phase fields either.** Turn = `moveCount & 1` (P1 opens);
  phase = whether `p2` is still the zero key. State is just
  `board[42] | moveCount | p1 | p2 | stake` (115 bytes, canonical layout in
  `src/state.ts`).
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
`blake2b(colByte || salt32)`, then both reveal, and the second reveal drops
BOTH discs in one transition. Same-column picks stack, with the round's
priority player (`round % 2`, 0 = p1) underneath — on a column's last free
slot the non-priority disc vanishes. A commitment to an already-full column
can never be revealed; its owner loses through the timeout door.

Reference in `src/simul/` (state + rules, same pure-function contract);
covenant as a second Argent actor pair in `contracts/fourk.ag` —
`FourkSimulLobby` (join/cancel) and `FourkSimul`, whose doors are, in
selector order: `dissolve`, `commit`, `reveal`, `resolve`, `claim_win`,
`claim_split`, `claim_draw`, `claim_timeout`, `split_timeout`,
`sudden_death`, `sweep_win` (appended last so earlier doors keep their
selector indexes). The classic actors' sources are untouched, so classic
play is unaffected.

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
  (`split_timeout`, permissionless). Same `this.age` clock as classic.
- **The salt lives in the browser** (`localStorage`, written before the
  commit broadcast). It is secret, so it cannot ride the share code: a pick
  sealed in one browser cannot be revealed from another — the timeout doors
  settle that, and the UI warns.
- **Sync**: reveal- and resolve-phase successors are enumerable (≤14 / ≤7
  addresses); a commit successor embeds the opponent's unpredictable hash
  and gets the join treatment — trace the spending tx, lift the pushes,
  verify the derived address holds the covenant UTXO.
- **Compute budget**: fourk-mode covenant inputs declare budget 20 (classic
  12) — every continuation rebuilds and hashes the ~4.3 KB `FourkSimul`
  successor template in-script (~131k script units measured live for join;
  budget 12 caps at 129,999).

## TS reference ↔ covenant mapping

The covenant state deviates from the TS reference in two deliberate ways:

- **`stake` is not a covenant state field.** The UTXO value *is* the pot: join
  enforces doubling (`output == 2 * input`), moves enforce preservation, and
  the terminal doors spend it. Fees therefore ride on a second wallet input,
  which also keeps storage mass at zero per KIP-9.
- **`phase` is an explicit int** (0 open, 1 live) where the TS derives it from
  `p2 == ZERO_PK`: an int compare is cheaper and safer in script than a
  32-byte compare. `join` re-checks the genesis invariants (empty board, zero
  move count), so a malformed genesis is simply unjoinable.

Payout enforcement is asymmetric on purpose: `claim_draw` is permissionless,
so both payout outputs are pinned to the players' keys; `cancel`,
`winning_move`, and `claim_forfeit` are signed by the party the whole pot
belongs to, so they direct funds freely like any wallet spend (no forced
address reuse). All four terminal doors require zero authorized covenant
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
`--utxoindex`) can be set via `VITE_NODE_URL` in `app/.env.local`. A Python
CLI once lived in `tool/` — it's in git history if a scriptable client is
ever needed again.

Transaction shapes and conventions (see `app/src/shared/lib/covenant.ts` for
details):

- All transactions are **v1** with per-input compute budgets (12 units for the
  covenant input — one Schnorr verify dominates — and 10 for P2PK funding).
- `open` derives the covenant id from the funding outpoint via
  `populate_genesis_covenants`; the id is the match's stable handle forever.
- `join`/`move` preserve the pot exactly, so fees ride on a wallet funding
  input with change; the signed terminal doors pay fees out of the pot.
- The sighash ignores signature scripts, so the tool signs a
  placeholder-shaped transaction and splices real signatures in afterwards.
- `sync` exploits that Connect Four successors are enumerable: it computes the
  P2SH address of every legal next state (≤ 7) and polls
  `get_utxos_by_addresses`, adopting whichever carries the match's covenant
  id. The one thing it cannot enumerate is a join (the successor embeds the
  joiner's unknown pubkey) — the joiner sends the updated match file back
  instead. `win` finds its own witness by scanning the successor board.
- `move` refuses to play a winning disc as a plain move unless `--force` — a
  guard against the "unclaimed win lost to the draw" edge in the design.

## The React app

Fully client-side; anyone can host it and any two browsers can play.

```
# one-time: build the two wasm packages
cd ../rusty-kaspa/wasm && ./build-web --sdk         # -> wasm/web/kaspa
cd ../../fourk/wasm && wasm-pack build --target web  # -> wasm/pkg

cd ../app
npm install
npm run dev        # or: npm run build && npm run preview
```

Both the app and the drip service default to the **public node resolver** —
no local node needed (verified live: public testnet-10 nodes are v2.0.1,
synced, Toccata-active, utxoindex-enabled, and serve wss so browsers connect
from anywhere). A local node still works via `VITE_NODE_URL` in
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
  stored as `fourk.account` v2). The **guest** key is the original invisible
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
  kind of secret, one thing to write down.

  Creating and signing in are the *same* operation: `switchAccount(phrase)`
  moves any balance off the outgoing account and then `adoptAccount` sets the
  new one, and that is the only way an account is ever set. A new phrase is
  generated on the acknowledgement screen and stored nowhere until the player
  confirms it, so abandoning that screen — backdrop, refresh, closed tab —
  leaves nothing behind rather than an account whose phrase was never read.
  There is likewise no drawer of retired keys: unfinished games on the
  outgoing account are what the switch confirmation warns about.
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

`fourk-wasm` is verified against the other stacks at runtime: identical script
bytes to silverc/the Python SDK, identical sigscript sizes for all six
entrypoints.

## Status / next steps

- [x] TS reference + adversarial property tests
- [x] Silverscript port, compiled and engine-verified (all six entrypoints)
- [x] Deployment CLI: v1 covenant transactions, genesis binding, all six
  transitions, chain sync/watcher (live on testnet-10: genesis, join, and
  moves confirmed; fee floor fixed after a live rejection)
- [x] React UI: client-side covenant compilation (fourk-wasm), tx build/sign
  in browser, lobby/board/watcher
- [x] Fourk mode (simultaneous commit-reveal play, the default): reference in
  `src/simul/`, `FourkSimulLobby`/`FourkSimul` actors, harness suite, wasm
  bindings, share-code mode section, salt store, round UI; verified live on
  a local simnet chain through join, collision rounds, `claim_win`,
  `claim_timeout`, and a classic regression game
  (`app/e2e/simul-live.test.ts` — the compute-budget bump to 20 came out of
  a live rejection there)
- [x] Production-readiness hardening pass: mandatory join-time deadline +
  clock bounds (a hostile invite can no longer trap or hostage a stake, and
  no pot can be stranded forever — liveness is a property test), the
  `claim_win` challenge window (the double-win mempool race is gone),
  invite/share-code validation (network binding, value↔stake, timing
  bounds), account-record salvage-not-destroy, evidence-based watcher and
  reset detection, multi-input + all-door-lineage + budget-probe harness
  coverage, CI for the TS side, security headers + deploy notes
  (`app/DEPLOY.md`), dispenser status + runbook (`faucet/RUNBOOK.md`)
- [ ] Live browser-vs-browser game on testnet-10 through every terminal path
- [ ] Pin/vendor the `argent-lang` + `silverscript` toolchains so the harness
  and artifact rebuilds run in CI; external audit of the compiler lowering
  before mainnet funds.
