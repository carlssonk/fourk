# Dispenser runbook

The dispenser is a 40-byte stateless covenant (`contracts/drip.sil`) that
funds free-play seats with no backend: its address never changes, and each
UTXO held at it is an independent "lane" that anyone can drip 10 TKAS from
at most once per cooldown (1200 DAA ≈ 2 minutes) via an unsigned spend.
Refilling is nothing more than sending TKAS to the address — every send
becomes a new lane. When all lanes are drained or cooling, free-mode
onboarding breaks (`DISPENSER_EMPTY` / `DISPENSER_COOLING` in
`app/src/shared/lib/dispenser.ts`), so the operational job is simply:
keep enough float in enough lanes.

## Check status

```sh
node faucet/fund-dispenser.mjs status
```

Defaults to public testnet-10 via the resolver; `KASPA_NETWORK_ID` /
`KASPA_RPC_URL` point it at a private chain (see `localnet/README.md`).
Healthy output looks like:

```
dispenser address: kaspatest:pr...
network: testnet-10, node: wss://...
total balance: 130.00 TKAS (13 drips) across 3 lane(s)
  lane 1: 50.00 TKAS, age 1889060 DAA — eligible now
  lane 2: 40.00 TKAS, age 109686 DAA — eligible now
  lane 3: 40.00 TKAS, age 1841429 DAA — eligible now
3 lane(s) eligible, 13 drips of float — healthy
```

Exit code 0 means healthy. Exit code 1 means refill recommended: fewer
than 2 lanes currently eligible, or total float below 10 drips (100 TKAS).
Lanes marked `cooling` become eligible again after the cooldown; `dust`
lanes are spent-out remainders and never come back.

## Refill

1. Put a funded key in `faucet/faucet.key` (hex private key, one line).
   On public testnet, fund its address from the community faucet.
2. Rehearse, then run:

   ```sh
   node faucet/fund-dispenser.mjs faucet/faucet.key --dry-run   # prints the plan, sends nothing
   node faucet/fund-dispenser.mjs faucet/faucet.key             # 3 lanes x 100 TKAS
   node faucet/fund-dispenser.mjs faucet/faucet.key 5 200       # 5 lanes x 200 TKAS
   ```

The script logs each txid as `tx N/M submitted: <txid>`; if a run fails
partway, the submitted transactions have landed — run `status` to see the
new lanes, then re-run for only the missing remainder. Alternatively, any
plain wallet send to the printed dispenser address works: each send is one
new lane. New lanes are claimable after one cooldown (~2 minutes).

## Monitoring

`status` is cron-friendly (quiet success is not built in, so route stdout
to a log and alert on the exit code):

```cron
*/30 * * * * cd /path/to/fourk && node faucet/fund-dispenser.mjs status >> /var/log/fourk-dispenser.log 2>&1 || <your-alert-command> "fourk dispenser needs a refill"
```

Every 30 minutes is plenty: the float policy below gives days of headroom,
and the point of the alert is "refill this week", not "refill this minute".

## Float policy

Each free game consumes ~2 claims (both seats), i.e. ~20 TKAS. The default
refill (3 lanes x 100 TKAS = 30 drips) covers ~15 free games. Size the
float to your expected traffic between checks, keeping in mind:

- **More lanes beats bigger lanes for burst capacity**: each lane serves
  one claim per cooldown, so 3 lanes cap throughput at ~3 claims / 2 min
  regardless of balance. If concurrent onboarding stalls with lanes still
  funded but `cooling`, add lanes, not balance.
- It's all valueless testnet float — err generous; there is nothing to
  protect by keeping it lean.

## Key custody

`faucet/faucet.key` is gitignored and holds only testnet float — losing or
leaking it costs nothing real. There is no registration anywhere: rotation
is simply generating a new key, funding its address, and using the new file.
The dispenser itself has no key at all; claims are unsigned script spends.

## After a testnet reset

A reset rewinds DAA to zero and erases every UTXO — the dispenser's lanes
and the faucet key's balance vanish, but all addresses (dispenser included)
stay valid. Recovery on the real testnet:

1. Re-fund `faucet/faucet.key`'s address from the public faucet.
2. `node faucet/fund-dispenser.mjs faucet/faucet.key` — same address as
   before the reset.
3. `status` should report healthy after one cooldown.

`localnet/reset.sh` rehearses this end-to-end on a private simnet chain,
including the app's reset banner — see `localnet/README.md`.
