#!/usr/bin/env bash
# Requires a TeamSpeak-enabled image built from this checkout. Every service
# uses a disposable profile and exposes no host ports.
set -euo pipefail
cd "$(dirname "$0")/../.."
dir=$(mktemp -d)
project=bridge-voice-test-$$
compose=(docker compose --env-file /dev/null -p "$project" -f docker-compose.yml -f "$dir/override.yml")
cleanup() {
  "${compose[@]}" down >/dev/null
  rm -rf -- "$dir"
}
trap cleanup EXIT

cat > "$dir/override.yml" <<'YAML'
services:
  bridge:
    image: ${BRIDGE_TEST_IMAGE:?select a TeamSpeak-enabled bridge image}
    container_name: !reset null
    restart: "no"
    ports: !reset []
    volumes: !reset []
    tmpfs: [/data]
    environment:
      TS3_URI: ""
      TS3_CLIENTQUERY_API_KEY: ""
      MUMBLE_URI: mumble://TestBridge@voice-server
      MUMBLE_BOT_URI: ""
      VNC_PASSWORD: disposable
  voice-server:
    image: mumblevoip/mumble-server:v1.5.939@sha256:2373aaf071dfcea95b0d45bc2ddf6c10318674a313a7e4816e826e9ba4bca942
    tmpfs: ["/data:mode=1777"]
YAML

export BRIDGE_TEST_IMAGE="${BRIDGE_TEST_IMAGE:-whatsapp-teamspeak-bridge-bridge:latest}"
healthcheck=$(docker image inspect --format '{{index .Config.Healthcheck.Test 1}}' "$BRIDGE_TEST_IMAGE")
for selection in teamspeak:gui mumble:gui mumble:native teamspeak-mumble:gui; do
  export BRIDGE_VOICE_BACKEND="${selection%:*}" BRIDGE_MUMBLE_CLIENT="${selection#*:}"
  docker compose --env-file /dev/null config --quiet
  "${compose[@]}" up --no-build -d
  active=(xvfb openbox x11vnc desktop-panel novnc pulseaudio bridge-bot)
  inactive=()
  case "$selection" in
    teamspeak:gui) active+=(teamspeak clientquery-relay clientquery-watchdog); inactive+=(mumble mumble-native) ;;
    mumble:gui) active+=(mumble); inactive+=(teamspeak clientquery-relay clientquery-watchdog mumble-native) ;;
    mumble:native) active+=(mumble-native); inactive+=(teamspeak clientquery-relay clientquery-watchdog mumble) ;;
    teamspeak-mumble:gui) active+=(teamspeak clientquery-relay clientquery-watchdog mumble-native); inactive+=(mumble) ;;
  esac
  for _ in {1..45}; do
    if "${compose[@]}" exec -T bridge supervisorctl status "${active[@]}" > "$dir/status" 2>/dev/null &&
        awk '$2 != "RUNNING" {exit 1}' "$dir/status" &&
        "${compose[@]}" exec -T bridge curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
    sleep 2
  done
  "${compose[@]}" exec -T bridge supervisorctl status "${active[@]}" | awk '$2 != "RUNNING" {print; exit 1}'
  "${compose[@]}" exec -T bridge curl -fsS http://127.0.0.1:9222/json/version >/dev/null
  "${compose[@]}" exec -T bridge curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
  "${compose[@]}" exec -T bridge supervisorctl status "${inactive[@]}" > "$dir/stopped" || true
  awk -v count="${#inactive[@]}" '$2 != "STOPPED" {exit 1} END {if (NR != count) exit 1}' "$dir/stopped"
  "${compose[@]}" exec -T bridge sh -c "$healthcheck"
  if [[ $selection == teamspeak-mumble:* ]]; then
    "${compose[@]}" exec -T bridge sh -ec 'echo headless > /data/browser-mode; test "$(bridge-browser-mode status)" = maintenance'
    "${compose[@]}" exec -T bridge supervisorctl stop mumble-native >/dev/null
    if "${compose[@]}" exec -T bridge sh -c "$healthcheck" 2>/dev/null; then
      echo >&2 'Combined health probe succeeded with native Mumble stopped'
      exit 1
    fi
  fi
  echo "PASS: $selection Supervisor startup"
done
