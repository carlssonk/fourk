# Private local chain — rehearsing a testnet reset

A single-node Kaspa chain you fully control: mine it, play on it, then wipe
it to reproduce exactly what a testnet reset does to the app (DAA score
rewinds to zero, every UTXO vanishes, addresses stay valid).

Defaults to **simnet** (minimum difficulty — blocks mine instantly at a
steady ~10/s). `KASPA_NETWORK=devnet` runs devnet instead, whose
testnet-like starting difficulty makes the JS miner take a few seconds per
block; same walkthrough, slower clock. Needs a `rusty-kaspa` checkout at
`~/dev/rusty-kaspa` (or set `RUSTY_KASPA_DIR`); `run-node.sh` builds
`kaspad` on first use.

## One-time app config

Add to `app/.env.local`:

```
VITE_NODE_URL=ws://127.0.0.1:17510
VITE_NETWORK_ID=simnet
VITE_RESET_MARGIN=500
```

`VITE_RESET_MARGIN` shrinks the reset threshold from 1M DAA (~28 h of
chain) to 500 (~1 min of mining) so the watermark is worth crossing in a
dev session. Remove all three lines to go back to public testnet-10.

## Run it

```sh
./localnet/run-node.sh         # terminal 1: the node
node localnet/mine.mjs 0       # terminal 2: mine continuously (~10 blocks/s)
```

The miner pays the faucet key, so once the first coinbases mature (~1000
blocks ≈ 2 min) the dispenser can be funded:

```sh
KASPA_NETWORK_ID=simnet KASPA_RPC_URL=ws://127.0.0.1:17510 \
  node faucet/fund-dispenser.mjs faucet/faucet.key
```

Then `pnpm --dir app start`, open the app, and play — lanes become
claimable once they age past the drip cooldown (1200 DAA ≈ 2 min of
mining).

## Simulate the reset

1. Let the miner run until the DAA score comfortably exceeds
   `VITE_RESET_MARGIN` (it logs the score every 500 blocks), and open the
   app at least once so it records the high-water mark
   (localStorage `fourk.daaHighWater.simnet`).
2. Stop the miner and the node (Ctrl-C both).
3. `./localnet/reset.sh` — wipes `localnet/.kaspad-simnet`.
4. Restart `run-node.sh` and the miner.
5. Reload the app.

Expected: the "test network was reset" banner appears once, stored
unfinished games flip to "The test network was reset — this game no longer
exists.", and an open game on screen finishes with the same message instead
of the "paste the invite link" dead end. New games work as soon as the
dispenser is re-funded (its address is unchanged — the fund command above
again).

The wallet keys survive by design: the app's browser wallet and
`faucet/faucet.key` are the same keys on any chain, only their balances are
gone — mirroring a real reset.

## Live suites in one command

```sh
./localnet/live.sh
```

Starts its own throwaway node on a fresh data dir (stop the dev node first;
both use port 17510), mines past coinbase maturity, runs
`app/e2e/*-live.test.ts`, and tears everything down. Any other command runs
against the same chain instead: `./localnet/live.sh node my-script.mjs`.
`kaspad` comes from `$KASPAD`, the `PATH`, or the `rusty-kaspa` checkout
above; the script's header has the `cargo install` line for the pinned
revision.

Tests that need the chain to stop at an exact DAA score
(`app/e2e/simul-v2-edges-live.test.ts`) hold the background miner by
creating the file `MINE_PAUSE_FILE` names (live.sh exports it) and mine
their own blocks. The browser suite runs against the same kind of chain:

```sh
./localnet/live.sh ./localnet/browser.sh
```

It funds the dispenser, waits out the lane cooldown, serves the app pinned
to the chain on port 5199 and runs `app/e2e/*.pw.ts`.

## When something fails

| Symptom | Cause | Fix |
|---|---|---|
| `live.sh`: something already listens on 127.0.0.1:17510 | The dev node from `run-node.sh` is up | Stop it; `live.sh` brings its own |
| `live.sh`: kaspad not found | No built `kaspad` | Set `KASPAD`, or run the `cargo install` line in the script header |
| App: `node ws://127.0.0.1:17510 is unreachable` | Node not running | `./localnet/run-node.sh` |
| App: node `is still syncing` / `running without the UTXO index` / `on …, not simnet` | Wrong flags or network | Start it with `run-node.sh` (it passes `--utxoindex --enable-unsynced-mining`); check `VITE_NETWORK_ID` in `app/.env.local` |
| Nothing confirms; the clock stands still | Miner not running | `node localnet/mine.mjs 0` |
| Funding fails with `one of the transaction inputs spends an immature UTXO` | Faucet coinbases younger than 1000 DAA | Keep mining (~2 min after a fresh start) |
| Free games: "temporarily unavailable" (`DISPENSER_EMPTY`) | Dispenser has no lanes on this chain | Fund it (command above) |
| New games: "try again in a minute" (`DISPENSER_COOLING`) | Every lane drained or cooling (1200 DAA) | Wait, or fund more lanes |
| A timed door: `transaction input #0 is not finalized`, or the app's "pick deadline not reached (about N minutes)" | Its lock time is ahead of the chain | Wait for the chain to pass it; the app's countdown shows when |
| A timed door: `one of the transaction sequence locks conditions was not met` | The game UTXO is younger than the door's clock | Wait out the clock |
| A move or pick: `already spent by transaction` / `is an orphan` | The opponent's transition landed first | Nothing: the app resyncs and replays a still-legal pick |
| Banner "the test network was reset" after `reset.sh` | Expected: the DAA score fell below the high-water mark | None; unfinished games are marked gone |
