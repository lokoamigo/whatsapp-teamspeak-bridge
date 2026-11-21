#!/usr/bin/env bash
# End-to-end test for Mumble chat commands: starts a throwaway Mumble server in
# Docker and runs e2e.js (on the host's Node) against it.
set -euo pipefail
cd "$(dirname "$0")/../.."

image="${MUMBLE_SERVER_IMAGE:-mumblevoip/mumble-server:latest}"
name="bridge-mumble-e2e-$$"
port="${MUMBLE_TEST_PORT:-64799}"
password="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" -p "127.0.0.1:${port}:64738" \
  -e MUMBLE_SUPERUSER_PASSWORD="$password" "$image" >/dev/null

for _ in $(seq 1 60); do
  docker logs "$name" 2>&1 | grep -q "Server listening on" && break
  sleep 0.5
done

if ! MUMBLE_TEST_PORT="$port" MUMBLE_TEST_SUPERUSER_PASSWORD="$password" node tests/mumble-commands/e2e.js; then
  echo "--- Mumble server log ---"
  docker logs "$name" 2>&1 | tail -40
  exit 1
fi
