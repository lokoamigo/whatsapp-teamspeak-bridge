#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Build the bridge first, or select an existing compatible image. Docker's
# --rm removes only this test container and its anonymous /data volume.
image="${BRIDGE_TEST_IMAGE:-whatsapp-teamspeak-bridge-bridge:latest}"
for suite in integration three-way; do
  backend=teamspeak
  if [[ $suite == three-way ]]; then backend=teamspeak-mumble; fi
  docker run --rm --network none --user bridge --entrypoint node \
    -e BRIDGE_VOICE_BACKEND="$backend" \
    --mount "type=bind,source=$PWD/bot,target=/opt/whatsapp-teamspeak-bridge/bot,readonly" \
    --mount "type=bind,source=$PWD/tests/audio-routing,target=/opt/whatsapp-teamspeak-bridge/tests/audio-routing,readonly" \
    "$image" /opt/whatsapp-teamspeak-bridge/tests/audio-routing/$suite.js
done
