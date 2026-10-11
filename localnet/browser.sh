#!/usr/bin/env bash
# The Playwright browser suite against live.sh's throwaway chain:
#
#     ./localnet/live.sh ./localnet/browser.sh [playwright args...]
#
# Funds the dispenser (free games claim from it), waits out the lane
# cooldown, serves the app pinned to the chain, and runs app/e2e/*.pw.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

export KASPA_NETWORK_ID=simnet
export KASPA_RPC_URL="${KASPA_RPC_URL:-ws://127.0.0.1:17510}"
PORT=5199

# Every fresh browser context is a new guest that claims one drip, and a
# lane serves one claim per cooldown: fund enough lanes for the whole suite.
node faucet/fund-dispenser.mjs faucet/faucet.key 40 50
# Lanes claim only after the cooldown (1200 DAA, ~2 minutes): `status`
# exits 0 once enough of them are eligible.
for _ in $(seq 90); do
  node faucet/fund-dispenser.mjs status >/dev/null 2>&1 && break
  sleep 5
done

cd app
VITE_NODE_URL="$KASPA_RPC_URL" VITE_NETWORK_ID=simnet VITE_RESET_MARGIN=500 \
  npx vite --port "$PORT" --strictPort >/dev/null 2>&1 &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  curl -sf "http://localhost:$PORT/" >/dev/null && break
  sleep 1
done

PLAYTEST_URL="http://localhost:$PORT" npx playwright test "$@"
