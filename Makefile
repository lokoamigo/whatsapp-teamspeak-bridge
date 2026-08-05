.PHONY: build restart up status logs

COMPOSE ?= docker compose

build:
	$(COMPOSE) build

restart:
	$(COMPOSE) up -d --force-recreate --build

up:
	$(COMPOSE) up -d

status:
	$(COMPOSE) ps
	$(COMPOSE) exec bridge supervisorctl status

logs:
	$(COMPOSE) logs -f bridge
