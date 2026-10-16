#!/usr/bin/env bash
# The whole local stack in one command: the dev simnet node, a miner, a
# funded dispenser, the sweeper (payouts and the Quick Match matchmaker),
# and the app pinned to that chain. Ctrl-C stops all of it;
# the chain itself (localnet/.kaspad-simnet) persists until reset.sh.
#
#     pnpm dev            # from the repo root
#     ./localnet/dev.sh   # same thing
#
# A node already listening on 127.0.0.1:17510, or a miner already running,
# is reused and left running.
# app/.env.local is not needed: the app's settings are passed here and take
# precedence over it.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=17510
export KASPA_NETWORK_ID=simnet
export KASPA_RPC_URL="ws://127.0.0.1:$PORT"
DATA=localnet/.kaspad-simnet
# Simnet coinbases mature after 1000 DAA; mine past that before funding.
WARMUP_BLOCKS=1100

up() { nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; }

NODE_PID=""
MINER_PID=""
SWEEPER_PID=""
cleanup() {
  [[ -n "$SWEEPER_PID" ]] && kill "$SWEEPER_PID" 2>/dev/null || true
  [[ -n "$MINER_PID" ]] && kill "$MINER_PID" 2>/dev/null || true
  [[ -n "$NODE_PID" ]] && kill "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$DATA"
if up; then
  echo "node: reusing the one on 127.0.0.1:$PORT"
else
  echo "node: starting (log: $DATA/node.log)"
  ./localnet/run-node.sh >"$DATA/node.log" 2>&1 &
  NODE_PID=$!
  # The first run may build kaspad; keep waiting while run-node.sh lives.
  until up; do
    kill -0 "$NODE_PID" 2>/dev/null || { tail -20 "$DATA/node.log" >&2; exit 1; }
    sleep 0.5
  done
fi

# Two keys of this chain's own, wiped with it by reset.sh. The faucet key
# gets only the warm-up's coinbases; the background miner pays the other.
# A key that collects every coinbase of a long-running chain ends up with
# millions of UTXOs, more than the kaspa wasm can fetch in one call.
newkey() {
  [[ -f "$1" ]] || (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >"$1")
}
FAUCET_KEY="$DATA/faucet.key"
MINER_KEY="$DATA/miner.key"
newkey "$FAUCET_KEY"
newkey "$MINER_KEY"

if ! node faucet/fund-dispenser.mjs status >/dev/null 2>&1; then
  echo "dispenser: low — mining $WARMUP_BLOCKS blocks so the faucet's coins mature, then funding"
  MINE_KEY_FILE="$FAUCET_KEY" MINE_DELAY_MS=0 node localnet/mine.mjs "$WARMUP_BLOCKS" >/dev/null
  node faucet/fund-dispenser.mjs "$FAUCET_KEY" 10 50 >/dev/null
  echo "dispenser: 10 new lanes, claimable in ~2 minutes (one drip cooldown)"
fi

# A second miner would double the chain's pace (block times drive every
# game clock), so leave one started elsewhere alone.
if pgrep -f 'mine\.mjs' >/dev/null; then
  echo "miner: reusing the one already running"
else
  echo "miner: running (log: $DATA/miner.log)"
  MINE_KEY_FILE="$MINER_KEY" node localnet/mine.mjs 0 >"$DATA/miner.log" 2>&1 &
  MINER_PID=$!
fi

# Built for simnet into the chain's own directory, never sweeper/dist
# (which infra/node deploys). Rebuilt every start: the app reloads as code
# changes, but a sweeper left running from an earlier start would keep the
# old matchmaker, and the two would quietly disagree (pairing across modes,
# refusing new terms).
SWEEPER_PORT=8791
SWEEPER_BUNDLE="$DATA/sweeper/sweeper.mjs"
# The hash of the bundle the running sweeper loaded, written when it starts:
# what "stale" is judged against, not the file on disk.
SWEEPER_STAMP="$DATA/sweeper.started"
SWEEPER_URL="http://127.0.0.1:$SWEEPER_PORT/sweep"

start_sweeper() {
  echo "sweeper: running on :$SWEEPER_PORT (log: $DATA/sweeper.log)"
  # Every local window shares 127.0.0.1, so lift the per-client limits.
  MATCH_SEEK_LIMIT=1000 MATCH_REQUEST_LIMIT=100000 \
    NODE_URL="$KASPA_RPC_URL" PORT="$SWEEPER_PORT" node "$SWEEPER_BUNDLE" >"$DATA/sweeper.log" 2>&1 &
  SWEEPER_PID=$!
  echo "$fresh" >"$SWEEPER_STAMP"
}

built=1
VITE_NETWORK_ID=simnet SWEEPER_OUT_DIR="$PWD/$DATA/sweeper" pnpm --dir app build:sweeper >/dev/null || built=0
fresh=$(shasum "$SWEEPER_BUNDLE" 2>/dev/null | cut -d' ' -f1 || true)
holder=$(lsof -t -iTCP:"$SWEEPER_PORT" -sTCP:LISTEN 2>/dev/null || true)
# Only a sweeper answers /healthz with these (503 "no node" while syncing).
health=$(curl -s --max-time 2 "http://127.0.0.1:$SWEEPER_PORT/healthz" 2>/dev/null || true)

if [[ -n "$holder" && "$health" != "ok" && "$health" != "no node" ]]; then
  echo "sweeper: :$SWEEPER_PORT is held by another program; Quick Match and payouts are off"
  SWEEPER_URL=""
elif [[ -n "$holder" ]]; then
  if [[ $built == 0 ]]; then
    echo "sweeper: build failed, reusing the one already running on :$SWEEPER_PORT"
  elif [[ "$(cat "$SWEEPER_STAMP" 2>/dev/null)" == "$fresh" ]]; then
    echo "sweeper: reusing the one on :$SWEEPER_PORT"
  else
    echo "sweeper: code changed, restarting the one on :$SWEEPER_PORT"
    kill $holder 2>/dev/null || true
    for _ in $(seq 50); do
      lsof -t -iTCP:"$SWEEPER_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 0.2
    done
    if lsof -t -iTCP:"$SWEEPER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "sweeper: the old one wouldn't stop; reusing it (stale until it does)"
    else
      start_sweeper
    fi
  fi
elif [[ $built == 0 ]]; then
  echo "sweeper: build failed; Quick Match and payouts are off"
  SWEEPER_URL=""
else
  start_sweeper
fi

VITE_NODE_URL="$KASPA_RPC_URL" VITE_NETWORK_ID=simnet VITE_RESET_MARGIN=500 \
  VITE_SWEEPER_URL="$SWEEPER_URL" \
  pnpm --dir app start
