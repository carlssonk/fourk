# fourk

Connect Four played on Kaspa. Each match is a covenant that holds the stakes and enforces the rules
on-chain; the app is a static site that builds and signs every transaction in the browser.

> **Note:** fourk runs on testnet-10 and simnet only. The covenant has not been externally audited;
> do not use it with mainnet funds.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | TypeScript reference rulebook: classic (`rules.ts`) and Fourk (`simul/`, `simul-v2/`) |
| `contracts/` | The Argent covenant `fourk.ag`, its compiled artifact in `build/`, and the `drip.sil` dispenser |
| `harness/` | Rust tests that run the compiled covenant on the rusty-kaspa script engine |
| `wasm/` | `fourk-wasm`: builds and checks covenant transactions in the browser |
| `app/` | The React app |
| `faucet/` | `fund-dispenser.mjs`, which refills the on-chain dispenser |
| `localnet/` | Scripts for a private simnet chain and the live test suites |
| `test/` | Property tests and the differential vectors shared with the covenant tests |

## Requirements

- Node.js and pnpm
- For the covenant tests and wasm builds: Rust and `wasm-pack`
- For a local chain: a `kaspad` binary, or a [rusty-kaspa](https://github.com/kaspanet/rusty-kaspa)
  checkout at `~/dev/rusty-kaspa` (built on first use)

The prebuilt `wasm/pkg/` and `vendor/kaspa-wasm/` are committed, so the app itself needs no Rust
toolchain.

## Running

The whole stack on a private chain (node, miner, funded dispenser and the app):

```bash
pnpm install && pnpm --dir app install
pnpm dev
```

The chain persists between runs; `pnpm chain:reset` wipes it. See [localnet](localnet/README.md).

The app against public testnet-10:

```bash
pnpm dev:testnet
```

## Testing

```bash
pnpm check           # types, TS suites, app lint
pnpm test            # reference rulebook: adversarial and property tests
pnpm test:covenant   # compiled covenant on the real engine, and the differential vectors
pnpm test:live       # end-to-end suites on a throwaway local chain
```

After a rules change, regenerate the differential vectors with `pnpm vectors`. After a covenant
change, rebuild the artifact and the wasm package:

```bash
argentc build contracts/fourk.ag --out contracts/build   # from the repo root
pnpm build:wasm
```

## Toolchain

Argent, Silverscript and rusty-kaspa are git-pinned in `harness/Cargo.toml` and `wasm/Cargo.toml`
to the revisions Argent's own workspace uses; the three must stay equal. Install the matching
compiler with:

```bash
cargo install --git https://github.com/argent-lang/argent \
  --rev 867b080b973f93d75c4b7ca8ce06950a963accbb argent
```

## Documentation

- [Design](docs/design.md): covenant doors, the reference mapping, accounts and staked play
- [Fourk shared deadlines](docs/fourk-shared-deadlines.md): the simultaneous-play protocol
- [Architecture decisions](docs/adr/)
- [Deploying the app](app/DEPLOY.md), [running the dispenser](faucet/RUNBOOK.md) and [our node](infra/node/README.md)
- [Glossary](CONTEXT.md)

## Status

Still open before a mainnet release:

- A live browser-to-browser game on testnet-10 through every ending
- An external audit of the compiler lowering

## License

ISC. See [LICENSE](LICENSE).
