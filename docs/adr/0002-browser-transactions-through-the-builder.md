# ADR 0002 — Browser transactions go through argent-runtime's TxBuilder

Date: 2026-09-13
Status: accepted

## Context

The browser used to assemble covenant spends itself: `fourk-wasm` exposed
per-actor "redeem script" and "signature script" functions, and
`app/src/shared/lib/engine.ts` built the transaction around them with the
kaspa SDK — funding inputs, outputs, covenant bindings, a placeholder-sign-
splice cycle for fees, and hand-declared compute budgets (12 classic, 20
fourk, each learned from a live node rejection).

Those two wasm functions had no upstream equivalent. They lived as an
uncommitted patch inside the sibling `argent-lang/argent` checkout, which
(a) made `argent-runtime` a path dependency that could not be pinned, so the
Rust suites could not run in CI, (b) silently kept the checkout on July 30
because the sync script skips dirty repos, and (c) meant the browser's
transaction path and the harness's were two different code paths verified
against each other only by a replay fixture that had itself gone stale.

The Silverscript 1.0 sync then exposed the cost of that split: entry
dispatch moved from small-int selectors to 4-byte tags, the harness passed,
and the app's spend classification (`discoverSpend`) broke without any test
noticing.

## Decision

`fourk-wasm` embeds argent-runtime's public `TxBuilder` and exposes one
transaction builder: a JSON spec (inputs, outputs, ordered entry arguments,
signer indices) in, a signed, engine-executed transaction with measured
compute budgets and consensus masses out. The app describes spends and
submits what comes back; it no longer touches scripts. Addresses come from
the same builder (`genesis_output`'s script public key). Spend
classification reads the actor's dispatch-tag table from the artifact.

Consequences that follow directly:

- `argent-runtime` is a plain git dependency at a pinned revision, equal in
  `harness/Cargo.toml` and `wasm/Cargo.toml`; no sibling checkout, no patch.
- The browser path IS the harness path. `wasm/tests/builder.rs` runs the
  app-shaped specs (genesis, join, move, pinned split, dispenser claim)
  natively against the engine; the replay fixture and the budget-probe
  tests are deleted because the property they guarded is now structural.
- A malformed spend fails in the browser with the builder's or the script
  engine's reason instead of an opaque node rejection.
- Fee sizing prices what the mempool prices: max(compute mass, normalized
  transient mass), from consensus-core's own calculator. Storage mass is
  reported, never charged.
- The dispenser claim rides the same builder as a ready-made-sigscript
  input, so its budget is measured too.

## Consequences

- Two engine executions per submitted transaction (a fee-sizing build and
  the final one); milliseconds, and the price of local verification.
- Secret keys are handed to `fourk-wasm` for signing. They already lived in
  wasm memory (the kaspa SDK's), so this adds no new exposure class.
- The wasm binary carries the script engine: 3.1 MB (opt-level z, LTO)
  where the address-only build was 1.0 MB. Acceptable for an app that
  already ships the kaspa SDK; the `[profile.release]` in wasm/Cargo.toml is
  what keeps it there.
- Adding a door means adding a spec, not a script: the mode supplies the
  actor and its state fields, the caller the ABI-ordered arguments, and the
  builder rejects wrong counts or types before anything is signed.
