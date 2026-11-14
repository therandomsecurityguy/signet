COMPOSE ?= docker compose
COMPOSE_FILES := -f docker-compose.yml -f docker-compose.override.yml
S ?=
PROFILES ?=
PROFILE_FLAGS := $(if $(PROFILES),--profile $(PROFILES),)
TRANSPARENCY_APPEND_LOG_ID ?= registry-governance-dev
TESSERA_SIDECAR_URL ?= http://tessera-sidecar:3400

.PHONY: help up up-knowledge up-tessera wire-tessera-aws down restart logs ps config build shell-mcp shell-api shell-registry shell-webapp shell-tessera shell-tessera-runtime

help:
	@echo "Targets:"
	@echo "  make up            # build + start all services"
	@echo "  make up-knowledge  # build + start stack with the optional vocbench profile"
	@echo "  make up-tessera    # build + start stack with the optional tessera sidecar profile"
	@echo "  make wire-tessera-aws # write Terraform-driven AWS env blocks into service env files"
	@echo "  make down          # stop and remove containers"
	@echo "  make restart       # restart all services"
	@echo "  make logs [S=mcp]  # follow logs (optional service filter)"
	@echo "  make ps            # show container status"
	@echo "  make config        # render merged compose config"
	@echo "  make build         # build images only"
	@echo "  make shell-mcp     # shell into mcp container"
	@echo "  make shell-api     # shell into api container"
	@echo "  make shell-webapp  # shell into webapp container"
	@echo "  make shell-registry# shell into registry container"
	@echo "  make shell-tessera # shell into tessera-sidecar container"
	@echo "  make shell-tessera-runtime # shell into tessera-runtime container"
	@echo ""
	@echo "Environment:"
	@echo "  MCP_PORT=3300 make up"
	@echo "  API_PORT=3200 make up"
	@echo "  WEBAPP_PORT=3300 make up"
	@echo "  TESSERA_SIDECAR_PORT=3400 make up-tessera"
	@echo "  TESSERA_RUNTIME_PORT=2024 TESSERA_DB_PORT=3307 make up-tessera"
	@echo "  TRANSPARENCY_APPEND_LOG_ID=registry-governance-dev make wire-tessera-aws"
	@echo "  VOCBENCH_PORT=1979 make up-knowledge"

up:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) up --build -d

up-knowledge: PROFILES=knowledge
up-knowledge: up

up-tessera: PROFILES=tessera
up-tessera: up

wire-tessera-aws:
	node ../scripts/wire-tessera-aws-env.mjs \
		--append-log-id "$(TRANSPARENCY_APPEND_LOG_ID)" \
		--sidecar-url "$(TESSERA_SIDECAR_URL)" \
		$(if $(TERRAFORM_DIR),--terraform-dir "$(TERRAFORM_DIR)",) \
		$(if $(DRY_RUN),--dry-run,)

down:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) down

restart:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) restart

logs:
	@if [ -n "$(S)" ]; then \
		$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) logs -f $(S); \
	else \
		$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) logs -f; \
	fi

ps:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) ps

config:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) config

build:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) build

shell-mcp:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec mcp sh

shell-api:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec api sh

shell-webapp:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec webapp sh

shell-registry:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec registry sh

shell-tessera:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec tessera-sidecar sh

shell-tessera-runtime:
	$(COMPOSE) $(COMPOSE_FILES) $(PROFILE_FLAGS) exec tessera-runtime sh
