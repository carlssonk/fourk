#!/usr/bin/env bash
# The live simnet suites, in one command: a throwaway kaspad on a fresh data
# dir, a miner, a funded faucet key, then the suites (or any command given),
# then teardown. Leaves the dev chain (localnet/.kaspad-simnet) alone.
#
#     ./localnet/live.sh                    # app/e2e/*-live.test.ts
#     ./localnet/live.sh node some-script   # anything else against the chain
#
# kaspad comes from $KASPAD, else PATH, else $RUSTY_KASPA_DIR (default
# ~/dev/rusty-kaspa)/target/release/kaspad. Build it at the revision the
# harness pins:
#     cargo install --locked --git https://github.com/kaspanet/rusty-kaspa \
#       --rev a41a333b08848f41bf737b72592e463a6011b8ac kaspad
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=17510
# Simnet coinbases mature after 1000 DAA; mine past that before anything
# spends from the faucet.
WARMUP_BLOCKS=1100

KASPAD="${KASPAD:-$(command -v kaspad || echo "${RUSTY_KASPA_DIR:-$HOME/dev/rusty-kaspa}/target/release/kaspad")}"
if [[ ! -x "$KASPAD" ]]; then
  echo "kaspad not found (set KASPAD, or see the build command at the top of $0)" >&2
  exit 1
fi
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  echo "something already listens on 127.0.0.1:$PORT (the dev node?); stop it first" >&2
  exit 1
fi

DATA="$(mktemp -d)"
NODE_PID=""
MINER_PID=""
cleanup() {
  [[ -n "$MINER_PID" ]] && kill "$MINER_PID" 2>/dev/null || true
  [[ -n "$NODE_PID" ]] && kill "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

"$KASPAD" --simnet --appdir="$DATA" --utxoindex --enable-unsynced-mining --disable-upnp \
  --rpclisten-borsh="127.0.0.1:$PORT" >"$DATA/kaspad.log" 2>&1 &
NODE_PID=$!
for _ in $(seq 120); do
  nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 && break
  kill -0 "$NODE_PID" 2>/dev/null || { tail -20 "$DATA/kaspad.log" >&2; exit 1; }
  sleep 0.5
done
nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 || { echo "kaspad did not open its wRPC port" >&2; exit 1; }

# The suites bankroll their players from the faucet key. CI has none; any
# fresh key works, since the miner below pays whichever key is there.
if [[ ! -f faucet/faucet.key ]]; then
  (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >faucet/faucet.key)
fi

# Tests that need the chain to stop at an exact score create this file to
# hold the background miner, then mine their own blocks (mine.mjs).
export MINE_PAUSE_FILE="$DATA/mine.pause"

echo "warming up: $WARMUP_BLOCKS blocks"
MINE_DELAY_MS=0 node localnet/mine.mjs "$WARMUP_BLOCKS" >/dev/null
node localnet/mine.mjs 0 >"$DATA/miner.log" 2>&1 &
MINER_PID=$!

if [[ $# -gt 0 ]]; then
  "$@"
else
  # One file at a time: both bankroll their players from the same faucet key,
  # and their acceptance-timing checks should not share a chain's load.
  SIMNET_E2E=1 VITE_NETWORK_ID=simnet npx vitest run --no-file-parallelism \
    app/e2e/classic-live.test.ts app/e2e/simul-v2-live.test.ts app/e2e/simul-v2-edges-live.test.ts
fi
