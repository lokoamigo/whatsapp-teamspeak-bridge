#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Build the bridge first, or select an existing compatible image. Docker's
# --rm removes only this test container and its anonymous /data volume.
image="${BRIDGE_TEST_IMAGE:-whatsapp-teamspeak-bridge-bridge:latest}"
docker run --rm --network none --user bridge --entrypoint node \
  --mount "type=bind,source=$PWD/bot,target=/opt/whatsapp-teamspeak-bridge/bot,readonly" \
  --mount "type=bind,source=$PWD/tests/audio-routing,target=/opt/whatsapp-teamspeak-bridge/tests/audio-routing,readonly" \
  "$image" /opt/whatsapp-teamspeak-bridge/tests/audio-routing/integration.js
