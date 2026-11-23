#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

name="bridge-native-e2e-$$"
server_image="${MUMBLE_SERVER_IMAGE:-mumblevoip/mumble-server:v1.5.939@sha256:2373aaf071dfcea95b0d45bc2ddf6c10318674a313a7e4816e826e9ba4bca942}"
bridge_image="${BRIDGE_TEST_IMAGE:-bridge-mumble-native-test:local}"
password="native-test-$RANDOM-$RANDOM"
cleanup() {
  docker rm -f "$name-client" "$name-server" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if ! docker image inspect "$bridge_image" >/dev/null 2>&1; then
  docker build -f tests/mumble-native/Dockerfile -t "$bridge_image" .
fi
test -x native/mumble/target/release/bridge-mumble || {
  echo >&2 'Build native/mumble/target/release/bridge-mumble before running this test.'
  exit 1
}
docker network create --internal "$name" >/dev/null
docker run -d --name "$name-server" --network "$name" \
  --tmpfs /data:rw,mode=1777 \
  -e MUMBLE_SUPERUSER_PASSWORD="$password" "$server_image" >/dev/null
for _ in $(seq 1 60); do
  docker logs "$name-server" 2>&1 | grep -q 'Server listening on' && break
  sleep 0.5
done
docker run --rm --name "$name-client" --network "$name" --user bridge --entrypoint node \
  -e MUMBLE_TEST_HOST="$name-server" -e MUMBLE_TEST_SUPERUSER_PASSWORD="$password" \
  --mount "type=bind,source=$PWD,target=/work,readonly" \
  "$bridge_image" /work/tests/mumble-native/e2e.js
