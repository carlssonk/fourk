# Our testnet-10 node

One rusty-kaspa node on Hetzner Cloud, served to browsers as
`wss://node.fourk.io` through a Cloudflare Tunnel. The app pins it with
`VITE_NODE_URL` and falls back to the public resolver when it does not
answer at startup (`connect()` in `app/src/shared/lib/engine.ts`).

```
browser ── wss://node.fourk.io ──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ kaspad :17210 (borsh)
browser ── https://node.fourk.io/sweep ──▶ (same tunnel) ──▶ sweeper :8080 ──▶ kaspad
                                                    Hetzner server, docker compose
other kaspa nodes ◀──────────── p2p :16211 ───────────▶ kaspad
```

wRPC never listens on a public interface: the firewall opens only P2P,
SSH and ICMP. The app refuses a node that is still syncing, lacks the
UTXO index or is on the wrong network, so kaspad runs with `--utxoindex`
on `--testnet --netsuffix=10`.

## First deploy

You need Terraform ≥ 1.6, Node and pnpm (for the sweeper bundle), an SSH
key in your agent, and:

- A Hetzner Cloud project API token (read/write).
- A Cloudflare API token with **Account → Cloudflare Tunnel → Edit** and
  **Zone (fourk.io) → DNS → Edit**.
- The Cloudflare account id and the `fourk.io` zone id (dashboard → the
  zone's Overview page, right column).
- Zero Trust set up on the account (open the Zero Trust dashboard once,
  choose a team name and the free plan); the tunnel API refuses an account
  that has never done this.

```sh
pnpm --dir app build:sweeper                   # from the repo root; see "Payout sweeper"
cd infra/node
cp terraform.tfvars.example terraform.tfvars   # fill it in
export HCLOUD_TOKEN=... CLOUDFLARE_API_TOKEN=...
terraform init
terraform apply
```

Apply creates the server, waits for cloud-init to install Docker, then
pushes `compose.yaml` and the tunnel token over SSH and starts the stack.

Then wait for the sync. Until it finishes the app keeps using the public
resolver (the pin is refused while `isSynced` is false), so nothing breaks:

```sh
ssh root@$(terraform output -raw ipv4) docker compose -f /opt/kaspa/compose.yaml logs -f kaspad
node check.mjs
```

Once `check.mjs` says `healthy`, set the GitHub repository variable
`VITE_NODE_URL` to `wss://node.fourk.io` and push (or re-run CI on `main`).
The next deploy pins the node, and `.github/workflows/node.yml` starts
checking it every 15 minutes; a failed run is the alert.

Cloudflare closes a websocket after about two minutes of silence, so the
app pings the node every 30 s (`KEEPALIVE_MS` in
`app/src/shared/state/rpc.ts`). Without it a player waiting on an opponent
dropped and reconnected every ~125 s.

## Payout sweeper

A Fourk win waits out a challenge window (about 5 minutes) before
`sweep_win` can pay it. Anyone may send `sweep_win`, and the covenant pins
its only output to the winner, so the `sweeper` service sends it for
players who have left. Players' clients send it too, and the match list
has a Collect button, so the sweeper is a convenience, never the only path.

- **What it does:** the app posts a pending win to
  `https://node.fourk.io/sweep` (`VITE_SWEEPER_URL`, see `app/DEPLOY.md`).
  The sweeper queues it only if this node holds a live game UTXO at the
  address its full state derives, then sends the sweep through the local
  kaspad when the window ends. Code: `app/sweeper/`.
- **What it holds:** no keys, no funds (the fee comes out of the pot,
  capped by the covenant's `MAX_FEE`), no names, and nothing on disk. A
  restart forgets the queue; the clients still cover those wins.
- **Limits:** 8 KB per request, 20 requests a minute per client
  (`CF-Connecting-IP`), 1,000 queued wins. These are in-process only; a
  Cloudflare rate-limiting rule on `/sweep` would stop floods before they
  reach the box, and needs a token with Zone → WAF → Edit.
- **Lockdown:** the container runs as `node`, read-only, with no
  capabilities, a memory and pid cap, and only the tunnel in front of it.
  It shares the box with kaspad, which browsers trust for chain data, so
  keep it that way.
- **Deploy a change:** `pnpm --dir app build:sweeper`, then
  `terraform apply`. The bundle's hash triggers the upload and restart; a
  missing bundle fails the plan. Build without `VITE_NETWORK_ID` (or with
  `testnet-10`): a simnet bundle refuses this node and only logs
  `waiting for ws://kaspad:17210`.
- **Logs:** `docker compose -f /opt/kaspa/compose.yaml logs -f sweeper`
  shows each sweep and anything it gave up on.

## Changes

- **Upgrade kaspad or cloudflared:** bump `kaspad_version` /
  `cloudflared_version` and `terraform apply`. The stack restarts in place
  and the chain data volume stays. Read the rusty-kaspa release notes
  first: some upgrades migrate the database one way.
- **Anything else in `compose.yaml.tftpl`:** same, apply restarts in place.
- **`cloud-init.yaml`** only runs on a new server; changes to it are
  ignored for the existing one on purpose, since replacing the server means
  a full resync. To rebuild anyway: `terraform apply -replace=hcloud_server.node`.
  The IPv4 address is a separate primary IP and survives the rebuild.

## Operating notes

- **Single node.** The fallback is startup-only: if the node dies, tabs
  already connected to it keep reconnecting to it rather than moving to the
  resolver, until they reload. New tabs fall back after ~3 s.
- **State holds secrets** (the tunnel token and secret), so it stays local
  and gitignored. If someone else needs to apply, move it to a remote
  backend with encryption at rest first, such as an R2 bucket through the
  `s3` backend.
- **SSH** is open to `ssh_allowed_cidrs` (everywhere by default, key-only).
  Terraform needs it to push the stack; narrow it if your address is stable.
- **Cost** is the server type plus the primary IPv4; check
  hetzner.com/cloud for current prices. Watch the server's traffic graph in
  the Hetzner console for the first weeks: P2P is the bulk of it, and it
  should stay well under the included traffic.
- **Sizing:** `cpx52` (12 shared vCPU, 24 GB, 480 GB) keeps about 50%
  headroom over Kaspa's stated testnet-10 minimum of 8 cores, 16 GB and
  256 GB SSD. Its vCPUs are shared, so if `node.yml` reports lag, dedicated
  cores are the next step. RAM is the tight one: if kaspad sits near the
  limit in `docker stats`, size up before it gets OOM-killed.
  If the disk fills, move to a larger server type with
  `terraform apply -var server_type=...` (Hetzner resizes in place, with
  a reboot; a disk upgrade cannot be undone).
