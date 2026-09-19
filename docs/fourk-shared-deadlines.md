# Fourk shared picking deadlines: feasibility review

Status: versioned reference rules and compiled contract proof implemented. Not
enabled in the app, live-node verified, or security-approved.

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
  signed readiness, shared picking deadlines, revealing, resolving, and all
  settlement paths. The generated artifacts include both protocol versions.
- Nine real-script-engine tests in `harness/tests/simul_v2_tests.rs` cover the
  transition matrix, deadline boundaries, both player orders, invalid metadata,
  settlement precedence, lobby exits, and a complete four-round double win.
- The four legacy template hashes are unchanged (the generated `.sil` files
  gain the shared V2 structs and helpers, but the legacy templates do not). A
  regression test pins the original hashes. Existing matches retain their rules.

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

1. Both players ready up before the initial timed round. Starting creates a
   round-start game output. Subsequent round starts are the outputs of valid
   resolves. Let S be that output's accepted DAA score and T the chosen picking
   duration. Both players' cutoff is D = S + T.
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

Before both players are ready, the host can dissolve immediately, the guest can
dissolve after T of inactivity, and permissionless cleanup can split after T.
Each signed ready transition happens at most once. Both ready closes those
lobby exits and anchors the first timed round at the new output's acceptance.

The overall cap does not turn a timeout win into a split or shorten an owed
response window. A final pending picking obligation may run beyond the cap;
one-sided reveal obligations and pending wins retain R before payment. Mutual
silence is cleaned up after the cap and the same wait the ordinary split door
uses: the full picking window T from the round start when nobody has picked,
the lobby clock T before both are ready, and R once both have picked. A
round-start output accepted at/after the cap cannot start another picking round.

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
- Readiness must be game-bound and non-replayable. No repeated ready action may
  restart an active round. Once both are ready, disable refund-style lobby
  cancellation and host kicking, even before a first pick, so an impending
  forfeit cannot be escaped by cancelling.
- Preserve an escape route from an abandoned pre-ready lobby. Define readiness
  expiry separately from active-round forfeits.
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
   verification, with legacy contract compatibility checks.
3. Pending: local-node tests of mining, actual acceptance scores, absolute and
   relative lock enforcement, mempool handling, collisions, and reorg/revalidation.
4. Pending: version-aware codecs, share codes, stored matches, successor discovery,
   transaction specs, and browser WASM rebuild. Preserve the legacy adapter;
   an already-funded covenant does not acquire new rules through a UI update.
5. Pending: readiness UI, shared picking countdown, confirmation feedback, and
   retry/recovery behavior. No app route creates V2 matches yet.

## Acceptance tests before rollout

- Picks at D-1 and D count; picks at D+1 cannot progress normal play.
- Low lock time, zero sequence, disabled sequence bits, and caller-provided
  timestamps cannot backdate a pick.
- A late first commit yields a draw, never a timeout win for its sender.
- A timely first commit followed by a late second commit preserves the first
  player's win, including when the late transaction beats the timeout claim.
- Both timely commits remain timely even if reveal/settlement occurs after D.
- No repeated commit, readiness action, rebase, reconnect, or refresh resets D.
- A second commit rebuilt on a first commit accepted within G of D is timely up
  to S1 + G and no later, and the first committer's timeout claim is not valid
  before that score.
- The input acceptance score read by the script and the contextual score used
  for the lock-time check refer to the same block score on a live node, so a
  pick accepted at the cutoff and a timeout claim after it cannot both stand.
- Unaccepted/sentinel metadata cannot validate a pick or manufacture a cutoff.
- Simultaneous submissions, stalled confirms, dropped transactions, accepted
  score changes, and restart recovery produce correct outcomes on a live node.
- Lobby exits stop at readiness; one/both missing ready players retain the
  intended safe exits. Timeout, reveal, cap, and win-challenge exits remain live.
- Correct fees and recipients for every outcome; no multi-match aggregation or
  wrong-player payout; Classic and old Fourk matches remain usable.

These are rollout gates. The reference and script-engine tests cover protocol
decisions; consensus, recovery, and browser behavior still require integration
verification before enabling V2 matches.
