#!/usr/bin/env bash
# A private single-node Kaspa chain for local fourk development. Its whole
# point is being disposable: reset.sh wipes it so a testnet reset can be
# rehearsed end to end (see README.md here).
#
# Defaults to simnet, whose genesis difficulty is the minimum — a JS nonce
# loop mines it instantly. KASPA_NETWORK=devnet gives testnet-like
# difficulty instead (~seconds per block in mine.mjs) if realism matters
# more than pace. The wRPC port is pinned so the app config never changes.
set -euo pipefail
cd "$(dirname "$0")"

NETWORK="${KASPA_NETWORK:-simnet}"
case "$NETWORK" in
simnet | devnet) ;;
*)
  echo "KASPA_NETWORK must be simnet or devnet, got '$NETWORK'" >&2
  exit 1
  ;;
esac

RUSTY="${RUSTY_KASPA_DIR:-$HOME/dev/rusty-kaspa}"
KASPAD="$RUSTY/target/release/kaspad"
if [[ ! -x "$KASPAD" ]]; then
  echo "kaspad not built yet — building from $RUSTY (one-time, takes a while)…"
  cargo build --release --bin kaspad --manifest-path "$RUSTY/Cargo.toml"
fi

# --enable-unsynced-mining: a lone peerless node never considers itself
# synced; without this it refuses to serve templates or accept blocks and
# the chain could never move at all.
exec "$KASPAD" "--$NETWORK" \
  --appdir="$PWD/.kaspad-$NETWORK" \
  --utxoindex \
  --enable-unsynced-mining \
  --disable-upnp \
  --rpclisten-borsh=127.0.0.1:17510
