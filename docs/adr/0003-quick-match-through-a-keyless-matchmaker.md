# ADR 0003 — Quick Match pairs players through a key-less matchmaker

Date: 2026-10-16
Status: accepted

## Context

Every game today starts from an invite link: the host opens a lobby
covenant and sends the share code to someone they already know. Home has
carried a disabled "Quick Match · soon" button since the initial commit.
Quick Match means pairing two strangers who both pressed it, which needs
somewhere they can find each other.

The chain can't serve as that place on its own. A lobby's P2SH address
derives from its state, p1's pubkey included, so there is no fixed address
to poll for open games. Two on-chain alternatives were considered:

- **Marker UTXOs.** Hosts post a small output to a well-known lobby
  address, and seekers poll it with `getUtxosByAddresses`. Every listing
  costs a transaction, cancelled or abandoned markers stay behind, and a
  marker says nothing about whether its host is still at the screen.
- **A queue covenant.** One singleton at a fixed address holding
  `empty | waiting(pk)`: one player spends it to sit in the queue, the next
  spends it to open a game with them and reset it. It needs no operator,
  but it still can't tell who is present (a player who closed the tab stays
  queued and the next one is paired with them). Every join, leave and pair
  is a fee, which the dispenser pays on free games. All seekers contend for
  one UTXO, and it would be a second covenant to design, test and audit.

Being present is what decides whether a pairing works. In Fourk mode an
absent opponent can't take anyone's stake: the first round can't forfeit
(`fourk-shared-deadlines.md`, "The first round"), so a host who never picks
costs the joiner a refund: at first after one picking window, and since the
covenant's `quick` flag (see the amendment under Consequences) at once,
through Leave game. That is tolerable as a safety net and unacceptable as
the normal case, so the matchmaker has to hand out only players who are
there.

The node box already runs a service of this kind: `app/sweeper` sits
behind the node's Cloudflare Tunnel, holds no keys, treats every request
as untrusted and checks it against the chain.

## Decision

Quick Match is a route in the sweeper process (`/match`) that pairs players
first; only then does the host open a game on-chain. Nobody's game sits on
chain while they wait alone.

1. **Seek.** Pressing Quick Match posts the player's guest pubkey to
   `POST /match/seek` and gets back a random ticket. The client polls the
   ticket (~2 s); the polls are the presence signal, and a ticket that stops
   polling is dropped.
2. **Pair.** When two live tickets are queued, the server pairs them; the
   one that waited longer hosts. A ticket is never paired with its own
   pubkey (two tabs of one browser).
3. **Host.** The host's client runs the existing `createGame` with the
   Quick Match terms and posts the share code to `POST /match/hosted`.
4. **Verify and forward.** The server derives the lobby address from the
   decoded state and requires a live lobby UTXO there with the Quick Match
   terms, an empty p2 and the paired host's pubkey as p1 (the same check the
   sweeper runs on a pending win). Only then does the partner's poll receive
   the code.
5. **Join.** The partner's client checks the terms itself (below) and joins
   through the existing `takeSeat`. The host's watcher sees the join as it
   does for an invite.
6. **Fallback.** If either side stops polling, or the host posts no valid
   code within ~30 s of pairing, the other player goes back into the queue.
   A host whose partner left before taking the code stays host, so its
   lobby (open or still opening) goes to the next seeker and no cancel
   transaction is spent; its 30 s grace keeps running across partners. A
   host polls through the open, so the 10 s presence check doesn't drop it. Once the code has been handed over the pair is
   done, and neither side leaving requeues the other. A lobby already
   opened by a host who then vanished is covered by the covenant's lobby
   exits and refunds; the matchmaker never serves it again. The poll
   states the client works from are listed in `app/sweeper/match.ts`.

**Terms (v1).** One fixed preset so everyone lands in one queue: Fourk
mode, free stake, 1,200 DAA per pick (about 2 minutes; first 3,000, changed
2026-10-16), and the overall cap `timingFor()` gives that clock (about a
day). Free games are signed by the guest key and funded by the dispenser,
for account holders too, the same split as private free games. The host's
disc colour wins, as with invites. The preset is one shared constant read
by the server, the client and both term checks.

**The joiner checks the terms itself.** Before `takeSeat`, the joiner's
client refuses a code whose decoded state isn't free stake, Fourk mode,
the preset clock and cap, and an open seat, and requeues. With that check,
the worst a broken or hostile matchmaker can do is pair badly or not at
all. It holds no keys, never handles a share code it hasn't checked
on-chain, and every transaction is still built and signed in the players'
browsers.

**Abuse limits.** The sweeper's per-IP rate limit (`CF-Connecting-IP`)
and caps on body size and queue length, applied to `/match` as well. They
also bound how fast a script can make the dispenser fund lobbies by
requeueing.

## Consequences

- No covenant change. The move-0 forfeit and P2-only dissolve sketched in
  `app/IDEAS.md` are classic-mode concerns, and classic stays out of Quick
  Match until it gets them (since joined without them; see the classic
  amendment below). *Amended 2026-10-16:* a `quick` flag was added to
  the Fourk V2 state after all, ahead of staked Quick Match. The host sets it
  at open, the terms (and so the matchmaker and the joiner) require it, and
  `dissolve` lets the joiner leave at once instead of after one clock. There
  is still no first-move forfeit: the first round stays unforfeitable, and a
  joiner facing a silent host is refunded after one window.
- The app depends on an operator service for one feature. Private games
  and every money path keep working without it; when the route is
  unreachable Quick Match says so and points to a private game.
  `DEPLOY.md`'s "no backend" still holds for the static site.
- Pairing before opening adds the host's open transaction (a few seconds)
  between "found an opponent" and the board. The existing "Connecting"
  steps cover it, and there is no Ready step.
- The matchmaker shares a process with payouts, so a crash there restarts
  the sweeper too. Players' own clients still send their sweeps, so a
  restart delays payouts but never loses them. Split it into its own
  Compose service if it grows.
- Deploy needs a `VITE_MATCH_URL` (or one derived from `VITE_SWEEPER_URL`),
  the `/match` path on the tunnel, the node host in the CSP's `connect-src`,
  and a matchmaker check in the node health workflow.
- One queue of free Fourk games is all v1 offers. Staked queues (an account
  and `STAKE_PRESETS` buckets), more clocks and classic mode are later
  decisions. *Amended 2026-10-16:* Classic joined, as a second queue. A seek
  names its mode, only equal modes pair, and the terms (2 minutes per move,
  free) are the same apart from the mode. Classic got no covenant change and
  so no `quick` flag: its joiner still waits out one clock to leave, which a
  silent host can make them sit through, and nothing forfeits at move zero
  (the `app/IDEAS.md` sketch is still the design for that). The app marks a
  paired game on its own record (`paired`) so both seats get Leave game
  rather than Kick opponent or Cancel game.
- 2 minutes per pick means a stalled opponent can hold you up that long per
  round. It's twice the covenant's 600 DAA floor, which leaves room for
  confirmation latency until it is measured on testnet-10 (the open timing
  gate in `fourk-shared-deadlines.md`, "Live-node verification"), and gives
  blind simultaneous picks some thinking time. The floor itself is not the
  target: it would leave the least room for a slow confirmation.
- Tests: server unit tests next to `sweeper.test.ts` (pairing, self-pair
  refused, timeouts and requeue, forged and wrong-terms codes rejected, rate
  limit); client queue-state tests through `Deps` with the in-memory chain;
  a two-client live test on a throwaway localnet; a two-context Playwright
  test.
