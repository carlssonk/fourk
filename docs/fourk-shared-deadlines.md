# Fourk shared picking deadlines: feasibility review

Status: versioned reference rules, compiled contract proof, app integration
(the `fourk2` mode) and a local-node verification suite implemented. New Fourk
games host on V2. Not run on a public network or security-approved.

This review concerns the dependency revisions pinned in `harness/Cargo.toml`,
not a claim about every Kaspa network or future compiler version. Classic's
alternating-turn timing is outside this change.

## Conclusion

A shared picking deadline has a plausible trustless implementation using the
consensus acceptance DAA score of the preceding game output. It is not safe to
implement as a browser-only countdown or a check of transaction lock time.

The important distinction is deferred validation: a commit transaction cannot
inspect its own eventual acceptance score. Its successor can inspect that score
and permit normal play only if the commit was timely. A late commit may therefore
be accepted on-chain, but must lead only to the appropriate terminal outcome.

Five diagnostic tests in `harness/tests/timing_feasibility.rs` pass against the
pinned compiler and real script engine. They verify the timing primitives, not a
complete replacement Fourk contract, consensus pipeline, or live-network flow:

```sh
cd harness
cargo test --locked --test timing_feasibility -- --nocapture
```

The subsequent contract-proof stage is also implemented:

- `src/simul-v2/rules.ts` defines the public reference rules, with six tests in
  `test/simul-v2.rules.test.ts`, including a seeded 300-case property test.
- `FourkSimulV2Lobby` and `FourkSimulV2` in `contracts/fourk.ag` implement joining,
  shared picking deadlines, the first round's refund rule, revealing, resolving,
  and all settlement paths. The generated artifacts include both protocol versions.
- Nine real-script-engine tests in `harness/tests/simul_v2_tests.rs` cover the
  transition matrix, deadline boundaries, both player orders, invalid metadata,
  settlement precedence, lobby exits, and a complete four-round double win.
- The first simultaneous protocol (`FourkSimulLobby`/`FourkSimul`) has since
  been retired from the contract and the app: nothing was in production, and
  it let a joiner's lone first-round pick forfeit an absent host.

The harness supplies input acceptance scores and checks scripts, not the full
consensus timing pipeline. These results do not replace live-node validation.

```sh
pnpm test
cargo test --locked --manifest-path harness/Cargo.toml
```

## Verified facts

- `require(tx.daa >= deadline)` compiles to a minimum lock-time check, not a read
  of the current chain score. The header-context validator permits the transaction
  once the contextual score is greater than its declared lock time.
- `require(this.ageDaa >= duration)` is a relative sequence-lock requirement.
  It does not expose exact elapsed time for arbitrary comparisons.
- Upper-bound forms such as `require(tx.daa <= deadline)` and
  `require(this.ageDaa <= duration)` are rejected by the pinned compiler.
- Reading `OpTxLockTime()` and comparing it to a deadline compiles, but is unsafe
  as an arrival-time check: the sender can declare an old lock time.
- `OpTxInputDaaScore(this.activeInputIndex)` reads the input UTXO's recorded
  `block_daa_score`. The script engine can distinguish scores at/before a fixed
  deadline from scores after it, independently of declared transaction lock time.
- Unaccepted mempool outputs have `UNACCEPTED_DAA_SCORE = u64::MAX`. The opcode's
  conversion yields -1. An upper-bound check alone would incorrectly accept it.
  Require a nonnegative, in-range accepted score before using it for timing.

Upstream sources, pinned to the app's engine revision:

- [Timing and input-score opcodes](https://github.com/kaspanet/rusty-kaspa/blob/a41a333b08848f41bf737b72592e463a6011b8ac/crypto/txscript/src/opcodes/mod.rs)
- [Absolute lock-time validation](https://github.com/kaspanet/rusty-kaspa/blob/a41a333b08848f41bf737b72592e463a6011b8ac/consensus/src/processes/transaction_validator/tx_validation_in_header_context.rs)
- [Relative lock-time validation](https://github.com/kaspanet/rusty-kaspa/blob/a41a333b08848f41bf737b72592e463a6011b8ac/consensus/src/processes/transaction_validator/tx_validation_in_utxo_context.rs)
- [Unaccepted-output sentinel](https://github.com/kaspanet/rusty-kaspa/blob/a41a333b08848f41bf737b72592e463a6011b8ac/consensus/core/src/constants.rs)

## Implemented round protocol

Use a single authoritative cutoff in DAA units. The boundary convention
is `accepted_score <= D` for timely picks, and timeout claims executable only at
scores greater than D. This matches an absolute transaction lock time of D; it
must be tested in consensus, not just the script engine.

1. From the second round on, a round starts at the output of a valid resolve.
   Let S be that output's accepted DAA score and T the chosen picking duration.
   Both players' cutoff is D = S + T. The first round has no round-start output:
   the joined lobby is where both players pick, and whichever pick lands first
   starts the other player's window (see "The first round" below).
2. The first commit reads S from its input metadata and persists D in its
   successor. D is not supplied freely by the caller. Track the first committer
   or last pending committer so late second commits have an unambiguous loser.
3. Before allowing the second commit, validate the first commit output's accepted
   score S1 against D. Store the second cutoff D2 = max(D, S1 + G), where G is
   the fixed rebase grace (`REBASE_GRACE`, 100 DAA, about ten seconds). Commits
   serialize on one UTXO, so a first commit accepted near D forces the opponent's
   in-flight commit to be rebuilt on its output and accepted again; without G a
   last-second first mover could turn that rebuild into a forfeit. G is bounded
   and only reaches past D when the first commit itself landed within G of D.
   The first committer's timeout claim on a one-commit state waits for the same
   score, so a graced second commit and that claim can never both be valid.
4. Before the first reveal, validate the second commit output's accepted score
   against the stored D2. The first commit has already been validated by the
   second commit transition. Only two timely commits may enter normal revealing.
5. Once both timely picks are established, use a separate reveal grace period.
   Keeping the existing per-obligation reveal timeout is a reasonable first
   scope: it is a liveness safeguard, not additional time to change a sealed pick.
   It still has the existing late-reveal versus timeout-claim race; a strict
   reveal cutoff would need additional deferred validation, including resolve.

The logical states can be encoded as phases or derived from slots plus timing
metadata. The implementation must explicitly preserve the following distinctions:

| State being spent | Normal continuation | Terminal outcome |
| --- | --- | --- |
| Round start, neither committed | First commit records D = S + T | After D, draw |
| First commit, accepted at S1 <= D | Second commit, storing D2 = max(D, S1 + G) | After D2, first committer wins if no timely second commit |
| First commit, accepted after D | None | Draw, because neither committed on time |
| Second commit, accepted by D2 | Reveal after validating its acceptance score | Existing reveal-stage timeout rules |
| Second commit, accepted after D2 | None | First committer wins |

Terminal late-commit branches must not require the late player's signature or
start another relative waiting period. Pin the correct recipient(s) and fees.
One late commit may consume the output a timeout claimant was about to spend,
but it must preserve that claimant's entitlement in the successor. The client
must follow the successor and retry settlement, rather than treating a lost
transaction race as a lost timeout right.

Every path out of a pending-commit state must respect these checks. A reveal,
draw, cancel, or other transition must not erase evidence of a late commit or
convert an already-established loss into an optional refund.

An independently proven board result takes precedence over subsequent picking
inactivity. As before, a valid four-in-a-row claim opens a challenge window and
a valid double-win proof can settle a draw. In V2 that challenge window and the
full-board draw delay use the separately configured reveal grace R, with
`600 <= R <= T`. Reveal grace is still a relative inactivity safeguard, not a
strict acceptance cutoff.

### The first round

Nobody has proven presence before their first pick. If the join output started
the clock, a host away from the tab could be forfeited by whoever joined — in
a staked game, a scanner joining idle lobbies and claiming through the
late-first-pick door. An explicit readiness step would fix that with two extra
signatures; the protocol instead makes the first round unable to forfeit:

- Either player's first commit spends the join output and stores no cutoff
  (`pick_deadline = 0`; the join must still be accepted before the cap). The
  lobby exits close at that pick.
- The second commit reads the first commit's acceptance S1 and stores
  D = S1 + T (the rebase grace is moot: T ≥ 600 > G). Reveals check the
  two-commit output's acceptance against D as in every round.
- A lone first-round pick nobody answers is refunded by `split_timeout` (and
  the cap) once `tx.daa >= S1 + T`; a second pick accepted after D is refunded
  at once. `claim_timeout` never pays a first-round pick (`v2TimeoutOwner`
  requires `round > 0` in its no-reveal branch). A reveal on the table is a
  proven obligation in any round and keeps its forfeit.
- This is safe because the first round is blind: nobody holds information
  that bailing could exploit, and a scanner gains nothing from an absent host.

Before the first pick, the host can dissolve immediately, the guest can
dissolve after T of inactivity, and permissionless cleanup can split after T.
The first committer in the first round has no clock of their own; the opponent
has T from that pick's acceptance, and the first committer can only wait or be
refunded. A first pick can land after the cap (the join was accepted before
it); the round then runs to `max(cap, S1 + T)`, consistent with the cap never
shortening an owed window.

The overall cap does not turn a timeout win into a split or shorten an owed
response window. A final pending picking obligation may run beyond the cap;
one-sided reveal obligations and pending wins retain R before payment. Mutual
silence is cleaned up after the cap and the same wait the ordinary split door
uses: the full picking window T from the round start when nobody has picked,
the lobby clock T before the first pick, T after a lone first-round pick, and R
once both have picked. A round-start output accepted at/after the cap cannot
start another picking round.

## UX and operational consequences

- A pick counts when accepted on-chain, not when clicked or merely broadcast.
  Show submitting/confirming separately from a confirmed pick. Both players see
  the same estimated cutoff and submitting one pick never resets it.
- Existing UTXO score tracking can supply S for the display, but the contract
  must calculate and enforce the authoritative value from input metadata.
- Single-output game transitions are serialized. Simultaneous commits may
  conflict and require rebasing, and a rebased commit must itself be accepted
  in time. The rebase grace G bounds the ordering disadvantage but does not
  remove it: the client must detect the conflict, rebuild on the accepted
  first commit, and be accepted within G. Every V2 transition that reads the
  input score also refuses an unaccepted parent, so commits and reveals cannot
  chain on mempool outputs. Test near-deadline collisions on a live node before
  choosing short competitive presets, and revisit G with measured rebuild
  latency; independent commit outputs are a larger possible redesign if this
  overhead is unacceptable.
- Refresh, reconnect, and another device must recover the same D. Never derive
  it from when a browser happened to observe a round.
- The lobby exits (host kick, guest cancel after one clock) close at the first
  pick. Nothing in the first round can be escaped by cancelling because nothing
  in it forfeits; from the second round on the round machine has no exit but
  the timeout doors.
- Preserve an escape route from an abandoned lobby and from an unanswered first
  pick: both are refunds, distinct from active-round forfeits.
- The overall cap, pending wins, and late-commit adjudication need explicit
  precedence. In particular, review any existing split door that could override
  a timeout winner. Do not reuse the current `roundStarted` and `inLobby`
  assumptions unchanged.
- Casual and competitive can share this protocol with different picking
  durations. Free/staked remains a separate choice. The current minimum is 600
  DAA (about one minute); shorter presets require an explicit bounds change and
  confirmation-latency testing. Reveal grace should be separately bounded.

## Implementation progress and remaining rollout gates

1. Completed: versioned TypeScript reference, adversarial/property tests, and
   Argent actors covering normal play and terminal guards.
2. Completed: pinned-compiler artifact generation and real-engine harness
   verification.
3. Completed: `app/e2e/simul-v2-live.test.ts` drives the app's real transaction
   engine for both players against the local simnet node (see "Live-node
   verification" below). Not covered: reorgs and public-network latency.
4. Completed: the `fourk2` mode (`app/src/shared/modes/fourk2/`), the share-code
   mode byte 2 and match.json keys, successor discovery for commits, the
   per-door lock-time/sequence gates, and the rebuilt `wasm/pkg`. The legacy
   `fourk` mode has since been removed (share-code mode byte 1 is refused).
5. Completed: the lobby as the first picking phase, the shared pick countdown
   (`ClockSpec`: UTXO age until the first pick of a later round, the absolute
   cutoff after any lone pick), lateness read off the acceptance stamp, and
   the stalled-round splits and first-round refunds as autopilot duties. An
   earlier revision had both players press Ready before the first round; the
   first-round refund rule replaced it (see "The first round").

## App integration

- **Acceptance stamp.** `Match.acceptedDaa` records the DAA score the chain
  accepted the current `txid` at, set only where the UTXO was observed alive
  (`engine.withEntry`) and dropped whenever `txid` changes without an
  observation. It is stored, never shared: a link recipient observes the UTXO
  itself. A fourk2 commit successor needs the spent output's score; a client
  that never saw that output alive reads it from the virtual chain
  (`engine.acceptedDaaOf`, `getVirtualChainFromBlock` + `getBlock`) starting
  at its persisted checkpoint, which predates the output because checkpoints
  are saved while the predecessor is current. Adoption declines rather than
  guessing when neither source has it.
- **Every V2 transition reads the input's score.** Commits and reveals refuse
  an unaccepted parent, so the client waits for acceptance instead of
  chaining on mempool outputs. Each action fetches the entry first, derives
  the successor from its score with the reference rules, and hands the same
  entry to the builder.
- **Gates per door** are computed from the state plus that score and checked
  against the reference before anything is built: a lone timely commit's
  claim locks at `max(D, S1 + G)`; a late second commit needs no gate; reveal
  states, pending wins and the full-board draw carry the reveal grace as
  sequence; the no-picks split locks at `S + T`; the cap settlement carries
  whichever of these applies on top of the deadline and pays a decided
  timeout winner in full.
- **Reveal grace R = T.** A shorter grace would forfeit a player who
  committed early and stepped away in a long-clock game (both reveals are
  owed the moment the second pick lands). One constant in
  `fourk2Engine.genesisFields`; the protocol allows any `600 <= R <= T`.
- **Clock copy.** The countdown is an estimate of the chain score; the status
  says a pick counts once the network confirms it. The joined lobby shows no
  forfeit clock (the guest's cancel countdown only); the lobby status says the
  first pick to land starts the other player's timer, and a first-round stall
  or late second pick reads "called off", never "claim the win".

## Live-node verification

`SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run app/e2e/simul-v2-live.test.ts`
with `localnet/run-node.sh` and `mine.mjs 0` running, or `pnpm test:live`
(`localnet/live.sh`), which brings its own chain and also runs in CI. The
edge suite (`simul-v2-edges-live.test.ts`) needs live.sh: it holds the miner
and steps the chain block by block to land transactions at exact scores, races
a timeout claim against a late pick on the node, and drives the cap,
`claim_split` and `claim_draw` settlements. The main suite has six tests, each with
fresh keys funded from the miner-paid faucet key:

- A full game from the joined lobby: the first pick stores no cutoff, the
  second stores exactly S1 + T; five rounds, `claim_win` and the sweep, with
  a later round's first cutoff checked as exactly the round-start acceptance
  plus T and its second cutoff as `max(D, S1 + G)`.
- A second pick accepted past the window in the first round: both reveals
  refused, both claims refused, the split refunds both.
- A second pick accepted past the cutoff and the grace in a later round: both reveals refused,
  the late player's claim and the split refused, the first committer paid.
- A first pick accepted past the window: the timeout claim refused, the split
  paid; and a round nobody picks in, split after the window.
- The rebase grace with T = 1200: the first pick five seconds before the
  cutoff, the second rebuilt after the cutoff but inside the grace, revealed
  and resolved; the first committer's claim refused.
- Lobby exits: a host kick of a joined lobby refunded; after the joiner's
  first pick neither exit nor a claim works, the split is refused until
  S1 + T ("not reached") and refunds both after it.
- Divergent clients: a host that never saw the join output alive re-derives
  the joiner's first pick from the virtual chain, and declines when its
  checkpoint is too late.

Result on 2026-09-20 against the local simnet node: 6 of 6 pass. The
submit-to-acceptance latency over 21 transitions was 1-2 DAA (one or two
blocks), which says nothing about a public network: a single local node has
no propagation delay, and the rebase grace of 100 DAA cannot be judged from
it. Measuring that latency on testnet is the remaining timing gate. The two
lock-time-gated doors (the one-commit claim and the no-picks split) are
refused by the mempool as "not finalized" until the chain passes the lock,
which the actions now check first so the UI gets minutes instead of a node
error.

The browser suites drive the lobby in the real UI: the two-browser Fourk
game (picks straight from the joined lobby, kick and cancel gone after the
first round), the lobby exits, the layout checks and the settlement flow (four
rounds, `claim_win`, the sweep) pass on the local simnet.

## Acceptance tests before rollout

- Picks at D-1 and D count; picks at D+1 cannot progress normal play.
- Low lock time, zero sequence, disabled sequence bits, and caller-provided
  timestamps cannot backdate a pick.
- A late first commit yields a draw, never a timeout win for its sender.
- A timely first commit followed by a late second commit preserves the first
  player's win, including when the late transaction beats the timeout claim.
- Both timely commits remain timely even if reveal/settlement occurs after D.
- No repeated commit, rebase, reconnect, or refresh resets D.
- A second commit rebuilt on a first commit accepted within G of D is timely up
  to S1 + G and no later, and the first committer's timeout claim is not valid
  before that score.
- A pick accepted at the cutoff and a timeout claim after it cannot both
  stand. The two scores involved are not the same block's: a new output
  records the DAA score of the chain block that ACCEPTED it
  (`utxo_validation.rs`), which is what `OpTxInputDaaScore` reads, while a
  lock time is checked against the block that INCLUDES the transaction, or
  the virtual score in the mempool (`lock_time < score`,
  `tx_validation_in_header_context.rs`). An accepting chain block always
  scores above the blocks it merges, so a claim locked at D2 lands strictly
  after D2, and a commit accepted by then has already spent its input.
  `app/e2e/simul-v2-edges-live.test.ts` checks both edges on a node, one
  block at a time.
- Unaccepted/sentinel metadata cannot validate a pick or manufacture a cutoff.
- Simultaneous submissions, stalled confirms, dropped transactions, accepted
  score changes, and restart recovery produce correct outcomes on a live node.
- Lobby exits stop at the first pick; an unanswered or late first-round pick
  refunds both and never pays either. Timeout, reveal, cap, and win-challenge
  exits remain live.
- Correct fees and recipients for every outcome; no multi-match aggregation or
  wrong-player payout; Classic matches remain usable.

These are rollout gates. The reference and script-engine tests cover protocol
decisions; consensus, recovery, and browser behavior still require integration
verification before enabling V2 matches.
