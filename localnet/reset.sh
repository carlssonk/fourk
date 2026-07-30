#!/usr/bin/env bash
# Simulate a testnet reset: wipe the local chain. Run with the node
# STOPPED; restart run-node.sh afterwards and the DAA score is back at
# zero — the app's high-water mark (app/src/shared/state/network.ts) then
# flags the reset on its next connect.
set -euo pipefail
cd "$(dirname "$0")"

NETWORK="${KASPA_NETWORK:-simnet}"

if pgrep -f "kaspad.*--$NETWORK" >/dev/null; then
  echo "kaspad is still running — stop it first (Ctrl-C in its terminal)" >&2
  exit 1
fi

rm -rf ".kaspad-$NETWORK"
echo "$NETWORK chain wiped — restart ./run-node.sh, mine a few blocks, reload the app"
