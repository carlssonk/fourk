# ADR 0004 — Free play stays on the key-less dispenser until traffic outgrows it

Date: 2026-10-16
Status: accepted

## Context

Free games are funded by the on-chain dispenser (`contracts/drip.sil`,
`app/src/shared/lib/dispenser.ts`, `faucet/RUNBOOK.md`). Each UTXO at its
fixed address is a lane, and anyone can take one 10 TKAS drip from a lane
once per cooldown (1200 DAA, ~2 minutes) with an unsigned spend. A new
guest's first free game takes one claim; the ~9 TKAS left over after the
seat carries them through several more games, so the dispenser limits how
fast *new* guests arrive, not how many people play at once.

On 2026-10-16 the dispenser held 9,560 TKAS in 17 lanes: one lane of
8,940 TKAS from a single large send, and 16 lanes of 30–40 TKAS left from
the workflow's 10 x 100 TKAS refills. Its throughput was:

- **Burst:** at most 17 new guests per 2 minutes. The small lanes held ~62
  drips between them, so after ~65 guests only the big lane was left: one
  new guest per 2 minutes, with 890 drips stuck behind its cooldown. A lane
  can't be split; the only way out of it is one claim at a time.
- **Sustained:** the workflow is scheduled every 30 minutes, but GitHub ran
  it every 4–5 hours. A refill added 100 claims, so about 50 new guests an
  hour once the float was drained.

The goal is thousands of new players per minute if the site becomes
popular. At 2,000 a minute, the key-less dispenser would need:

| | At 2,000 new players/min |
|---|---|
| Eligible lanes | 4,000 to keep pace (2,000/min x 2 min); ~8,000 with headroom for races |
| Refills | ~200 new 100-TKAS lanes every minute |
| TKAS | 20,000 a minute, ~29M a day |

Lane count is the easy part. The design itself stops working at that scale:

1. **Abuse grows with capacity.** Claims are unsigned by design, so one
   script can drain `lanes x 10 TKAS` every cooldown: 80,000 TKAS per
   2 minutes from 8,000 lanes. Players then get `DISPENSER_COOLING`. An
   open tap can't be both large and protected.
2. **Node load.** Every claim calls `getUtxosByAddresses` on the dispenser
   and downloads every lane (`claimDrip` in `dispenser.ts`). That is
   thousands of lane UTXOs, fetched thousands of times a minute, from public
   resolver nodes that rate-limit.
3. **Collisions.** A lane spent in the mempool still looks eligible until
   it is mined, so concurrent claimers pick the same lanes; `ensureFunds`
   gives up after its second lost claim (`SEAT_SETUP_FAILED`).
4. **Supply.** Tens of millions of TKAS a day is far beyond what public
   testnet faucets hand out; it would have to be mined.
5. **Scheduling.** GitHub's scheduled runs are hours apart under load, so
   no refill policy on Actions can follow traffic minute by minute.

## Decision

Keep the key-less dispenser for now, and shape the float for burst
capacity instead of balance. The workflow's `env` block
(`.github/workflows/dispenser.yml`) changes from

```
MIN_LANES: 10   REFILL_LANES: 10    REFILL_TKAS_PER_LANE: 100   MIN_KEY_TKAS: 2000
```

to

```
MIN_LANES: 50   REFILL_LANES: 100   REFILL_TKAS_PER_LANE: 50    MIN_KEY_TKAS: 10000
```

- 100 lanes x 50 TKAS is 5,000 TKAS, under `fund-dispenser.mjs`'s 10,000
  TKAS guard, and builds as one transaction (dry-run on testnet-10).
- With the extra lanes from a refill, about **115 lanes** are eligible:
  **~55 new guests a minute** for ~10 minutes (5 claims per lane, about
  550 guests), then one every 2 minutes from the big lane until the next run.
- **Sustained:** 500 claims per refill plus the big lane's 30 an hour, so
  roughly **130–150 new guests an hour** at the 4–5 hour cadence seen.
- `MIN_KEY_TKAS` is two refills, so the low-balance email arrives with one
  refill still in hand.

The big lane is left alone. It can't be spread out, and it guarantees one
claim every 2 minutes for about 30 hours of continuous use.

This needs nothing new on the client or the chain, and keeps free play
working with no backend.

## When to revisit

Move to the plan below when any of these show up:

- Players see `DISPENSER_COOLING` or `DISPENSER_EMPTY` (Free games
  unavailable / "Try again in a minute").
- A `status` run (or a workflow summary) shows most lanes cooling, or fewer
  than 10 eligible, between scheduled runs.
- New guests regularly arrive faster than ~50 a minute, or faster than
  ~150 an hour over a day.
- Before a launch or public post expected to bring that traffic. Until the
  service exists, pre-fund by hand: `node faucet/fund-dispenser.mjs
  faucet/faucet.key 200 50 --force` (10,000 TKAS, 200 lanes), and dispatch
  the workflow during the event instead of waiting for the schedule.

## Scale-up plan: a gated payout service

Fund free-play seats from the helper service that already runs Quick Match
and the sweeper (`app/sweeper`, behind the node's Cloudflare Tunnel).

1. **Request.** The client posts its guest address to a new route,
   `POST /fund`, with a Cloudflare Turnstile token. Turnstile is normally
   invisible, so this adds no click.
2. **Gate.** The server checks the token, rate-limits per
   `CF-Connecting-IP` (`limit.ts` already does this for `/match`), and
   rejects an address it has paid recently or that already holds a seat's
   worth.
3. **Batch.** Accepted requests are collected for about a second and paid
   in one transaction with one output per guest, from a hot wallet the
   service holds. 2,000 a minute is a few transactions a minute, with no
   lanes, cooldowns or collisions.
4. **Confirm.** The response carries the txid. The client waits for the
   output the way `ensureFunds` waits for a claim today, and nothing else
   in the game flow changes.
5. **Smaller drip.** Pay ~2 TKAS (one free seat, `FREE_STAKE`, plus fee
   headroom) instead of 10, which cuts supply by about 5x. In the service
   this is a config value; in the covenant it would change the dispenser's
   address.
6. **Refill.** The service tops its hot wallet up from the funding key, or
   the key is the hot wallet. Supply is still the open question at this
   scale: plan on mining TKAS.

Keep the key-less dispenser as the fallback: when `/fund` fails or times
out, the client claims from a lane as it does now. Free play then degrades
to today's capacity during an outage instead of stopping.

## Consequences

- The workflow now spends 5,000 TKAS per refill instead of 1,000, and its
  first run after this change will refill, since 17 lanes is under 50. The
  funding key held 18,179.84 TKAS, so the low-balance email arrives after
  the second refill.
- The service plan gives up the "no backend at all" property of free play
  (`dispenser.ts`): free games would depend on the service, and the service
  would hold a key with float in it. The float is testnet money, so a leak
  costs nothing real; an outage drops new guests to the fallback's capacity.
- Mainnet is out of scope for both. The dispenser and `fund-dispenser.mjs`
  refuse mainnet, and a payout service would have to as well.
