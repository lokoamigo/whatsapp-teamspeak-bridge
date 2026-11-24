.PHONY: build restart up status logs version version-check version-check-tag version-bump

COMPOSE ?= docker compose

build:
	$(COMPOSE) build

restart:
	$(COMPOSE) up -d --force-recreate --build

up:
	$(COMPOSE) up -d

status:
	$(COMPOSE) ps
	$(COMPOSE) exec bridge sh -c '\
	  case "$${BRIDGE_VOICE_BACKEND:-teamspeak}" in \
	    teamspeak-mumble) set -- teamspeak clientquery-relay clientquery-watchdog mumble-native ;; \
	    mumble) \
	      if [ "$${BRIDGE_MUMBLE_CLIENT:-gui}" = native ]; then set -- mumble-native; else set -- mumble; fi ;; \
	    *) set -- teamspeak clientquery-relay clientquery-watchdog ;; \
	  esac; \
	  if [ "$$(bridge-browser-mode status)" = maintenance ]; then set -- xvfb openbox desktop-panel x11vnc "$$@"; fi; \
	  exec supervisorctl status pulseaudio novnc bridge-bot "$$@"'

logs:
	$(COMPOSE) logs -f bridge

version:
	@node scripts/version.js show

version-check:
	@node scripts/version.js check

version-check-tag:
	@test -n "$(TAG)" || (echo "Usage: make version-check-tag TAG=vX.Y.Z" >&2; exit 2)
	@node scripts/version.js check-tag "$(TAG)"

version-bump:
	@test -n "$(BUMP)" || (echo "Usage: make version-bump BUMP=<major|minor|patch|x.y.z>" >&2; exit 2)
	@node scripts/version.js bump "$(BUMP)"
