# localnet

A private single-node Kaspa chain for development, the live test suites, and rehearsing a testnet
reset. Defaults to simnet (~10 blocks/s); `KASPA_NETWORK=devnet` runs devnet instead.

`kaspad` comes from `$KASPAD`, the `PATH`, or a rusty-kaspa checkout at `~/dev/rusty-kaspa`
(`RUSTY_KASPA_DIR` overrides it), built on first use.

## Running

```bash
pnpm dev            # from the repo root
```

Starts the node, mines past coinbase maturity, funds the dispenser when it is low, and serves the
app pinned to the chain; `app/.env.local` is not needed. A node or miner that is already running is
reused. Ctrl-C stops what it started; the chain persists until `pnpm chain:reset`.

Free games work once the dispenser lanes age past the drip cooldown (about 2 minutes of mining).
Logs are in `localnet/.kaspad-simnet/{node,miner}.log`.

### By hand

```bash
./localnet/run-node.sh       # the node
node localnet/mine.mjs 0     # mine continuously
```

with `app/.env.local`:

```
VITE_NODE_URL=ws://127.0.0.1:17510
VITE_NETWORK_ID=simnet
VITE_RESET_MARGIN=500
```

This miner pays `faucet/faucet.key` (`MINE_KEY_FILE` picks another). Once its coinbases mature,
fund the dispenser and start the app:

```bash
KASPA_NETWORK_ID=simnet KASPA_RPC_URL=ws://127.0.0.1:17510 \
  node faucet/fund-dispenser.mjs faucet/faucet.key
pnpm --dir app start
```

Keep a long-running miner off the faucet key: millions of coinbase UTXOs make it unusable.
`pnpm dev` uses separate `faucet.key` and `miner.key` files for this reason.

## Live suites

```bash
./localnet/live.sh                        # app/e2e/*-live.test.ts
./localnet/live.sh ./localnet/browser.sh  # the Playwright suite, app/e2e/*.pw.ts
```

Each run starts its own node on a fresh data dir, mines, runs the suite and tears everything down.
It uses port 17510, so stop the dev node first. Any other command runs against the same chain:
`./localnet/live.sh node my-script.mjs`.

## Simulating a testnet reset

`VITE_RESET_MARGIN=500` lowers the reset threshold from 1M DAA to 500, so a dev session can cross it.

1. Mine past the margin and open the app once, so it records the high-water mark.
2. Stop `pnpm dev`, run `pnpm chain:reset`, then `pnpm dev` again.
3. Reload the app.

The "test network was reset" banner appears once, and unfinished games are marked as gone. The
browser's keys survive, as they would on a real reset; only their balances are gone.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `live.sh`: something already listens on 127.0.0.1:17510 | The dev node is running | Stop it; `live.sh` starts its own |
| `kaspad` not found | No built node | Set `KASPAD`, or run the `cargo install` line in `live.sh` |
| App: node is unreachable | Node not running | `pnpm dev` |
| App: node is syncing, has no UTXO index, or is on another network | Wrong flags or network | Start it with `run-node.sh`; check `VITE_NETWORK_ID` |
| Nothing confirms | Miner not running | Restart `pnpm dev`, or `node localnet/mine.mjs 0` |
| Funding: `spends an immature UTXO` | Faucet coinbases are under 1000 DAA old | Keep mining (~2 min after a fresh start) |
| `fund-dispenser.mjs`: `RuntimeError: unreachable` | The faucet key holds too many coinbase UTXOs | Use `pnpm dev`, or `pnpm chain:reset` |
| Free games unavailable (`DISPENSER_EMPTY`) | No funded lanes on this chain | Restart `pnpm dev` |
| "Try again in a minute" (`DISPENSER_COOLING`) | Every lane is cooling down | Wait, or fund more lanes |
| `input #0 is not finalized` | A lock time is ahead of the chain | Wait; the app shows a countdown |
| `sequence locks conditions was not met` | The game UTXO is younger than the door's clock | Wait out the clock |
| `already spent by transaction` / `is an orphan` | The opponent's transaction landed first | Nothing: the app resyncs |
