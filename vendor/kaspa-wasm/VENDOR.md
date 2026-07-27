# Vendored kaspa-wasm build

Prebuilt `kaspa-wasm` web SDK (v2.0.1 with covenant/KIP-20 support), vendored
so the repo is self-contained — the app, the dispenser refill script, and the
harness replay-fixture generator all load it from here.

- Source: https://github.com/kaspanet/rusty-kaspa
- Commit: 78257f273a26c4be085bab0f79437dee99ca8835 (v2.0.1-6-g78257f27, clean tree)
- Built with the repo's wasm web build (wasm-pack, `web` target), taken from
  `rusty-kaspa/wasm/web/kaspa/`.

To upgrade: rebuild the wasm SDK in rusty-kaspa, replace this directory's
`kaspa.js` / `kaspa.d.ts` / `kaspa_bg.wasm*` / `package.json`, and update the
commit hash above. The version must stay in lockstep with the `kaspa-txscript`
tag pinned in `wasm/Cargo.toml` and the harness workspace.
