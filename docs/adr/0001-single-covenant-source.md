# ADR 0001 — Single covenant source: retire fourk.sil

Date: 2026-08-08
Status: accepted

## Context

The classic rules were ported to a covenant twice, by hand: first
`contracts/fourk.sil` (Silverscript, classic only), then `contracts/fourk.ag`
(Argent, classic + fourk mode) — ported *from* the `.sil`, not generated from
it. The `.ag` is what actually ships: `argentc build` produces
`contracts/build/` (generated `sil/*.sil` + `artifact.json`), which the
harness executes, the wasm crate embeds, and the browser compiles against.

`fourk.sil` never received the simul doors and had become a feature-frozen
fork, kept alive by `harness/tests/covenant_tests.rs` (1204 lines) — a suite
whose scenario table `argent_tests.rs` explicitly replays against the `.ag`.
The three genesis-gate constants (`MIN_MOVE_TIMEOUT`, `MAX_MOVE_TIMEOUT`,
`DEADLINE_LIMIT`) were hand-copied across six files, held in sync only by
comments.

## Decision

Delete `contracts/fourk.sil` (with its `silverc` artifacts `fourk.json` and
`genesis_args.json`) and `harness/tests/covenant_tests.rs`. The repo has one
hand-authored covenant source: `contracts/fourk.ag`.

The two `covenant_tests.rs` case families with no `argent_tests.rs` analog
were checked before deletion: both are **unrepresentable** in the two-actor
`.ag` design rather than untested (join/cancel against a live match targets a
different template entirely; a dirty genesis board cannot exist because join
constructs the board from a constant). No adversarial coverage was lost.

The surviving constant copies (TS reference, `.ag`, the two Rust suites) are
pinned by `harness/tests/constants_tests.rs`, which parses each source and
fails on drift — a test where comments used to be.

## Consequences

- Cross-validation of the rules lives where it always mattered: the TS
  reference (property tests, including liveness) vs. the compiled `.ag` on
  the real engine (`argent_tests.rs`, `simul_tests.rs`) — two independent
  statements of the rulebook, mechanically compared.
- A future architecture review should not re-suggest a second hand-ported
  covenant implementation; if defense-in-depth beyond the TS↔`.ag` pair is
  wanted, extend the harness matrix instead.
- `silverscript-lang` stays a harness dependency — it still compiles
  `contracts/drip.sil` (the dispenser, which remains Silverscript by design:
  a 40-byte stateless covenant has nothing to gain from actors).
