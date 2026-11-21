#!/usr/bin/env bash
# Reproducible harness for rootfs/usr/local/bin/tile-bridge-windows.
# Throwaway container only; no compose, no volumes, no browser.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE=tile-test:local
# Optional: TILE_SCRIPT=/path/to/other/version ./run.sh

docker build -q -t "$IMAGE" "$HERE" >/dev/null

exec docker run --rm \
  -e DISPLAY_WIDTH="${DISPLAY_WIDTH:-1440}" -e DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-900}" \
  -v "${TILE_SCRIPT:-$REPO/rootfs/usr/local/bin/tile-bridge-windows}:/usr/local/bin/tile-bridge-windows:ro" \
  -v "$REPO/rootfs/etc/bridge:/etc/bridge:ro" \
  -v "$HERE/test_tile.py:/harness/test_tile.py:ro" \
  "$IMAGE" python3 -u /harness/test_tile.py
