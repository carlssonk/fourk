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
