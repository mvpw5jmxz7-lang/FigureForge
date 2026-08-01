# FigureForge dev environment.
#
# This host runs rootless podman with no compose provider installed, so the
# primary entry point is a POD: both containers share one network namespace,
# which means the web container reaches the API on plain localhost:8000 and
# ports are published once, at pod level.
#
# `compose.yaml` is provided as an equivalent for anyone on Docker proper.

POD  := figureforge
ROOT := $(shell pwd)

# :z relabels bind mounts for SELinux (this is Fedora); without it the
# container gets permission denied on every mounted path.
MOUNT := -v $(ROOT):/app:z

.DEFAULT_GOAL := help
.PHONY: help build up down restart logs ps sh-web sh-api test test-web test-api acceptance lint clean

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build both container images
	podman build -t figureforge-web -f docker/web.Dockerfile .
	podman build -t figureforge-api -f docker/api.Dockerfile .

up: build ## Create the pod and start web (:5173) + api (:8000)
	-podman pod exists $(POD) || podman pod create --name $(POD) -p 5173:5173 -p 8000:8000
	-podman rm -f figureforge-web figureforge-api 2>/dev/null
	podman run -d --pod $(POD) --name figureforge-api \
		-v $(ROOT)/services/api:/app:z \
		figureforge-api
	podman run -d --pod $(POD) --name figureforge-web \
		$(MOUNT) -v figureforge-node-modules:/app/node_modules \
		figureforge-web
	@echo ""
	@echo "  web  -> http://localhost:5173"
	@echo "  api  -> http://localhost:8000/health"
	@echo "  logs -> make logs"

down: ## Stop and remove the pod
	-podman pod rm -f $(POD)

restart: down up ## Recreate the pod

logs: ## Follow logs from both containers
	podman logs -f figureforge-web & podman logs -f figureforge-api

ps: ## Show pod status
	podman ps --pod --filter pod=$(POD)

sh-web: ## Shell into the web container
	podman exec -it figureforge-web bash

sh-api: ## Shell into the api container
	podman exec -it figureforge-api bash

test: test-web test-api ## Run all tests

test-web: ## Run the TypeScript test suite
	podman run --rm $(MOUNT) -v figureforge-node-modules:/app/node_modules \
		figureforge-web npm test

test-api: ## Run the Python test suite
	podman run --rm -v $(ROOT)/services/api:/app:z figureforge-api \
		python -m pytest -q

acceptance: ## Run the end-to-end figure flow (needs `make up` first)
	podman exec -w /app figureforge-web npx vite-node scripts/acceptance.ts

lint: ## Lint both codebases
	podman run --rm $(MOUNT) -v figureforge-node-modules:/app/node_modules \
		figureforge-web npm run lint
	podman run --rm -v $(ROOT)/services/api:/app:z figureforge-api ruff check .

clean: down ## Remove the pod and the node_modules volume
	-podman volume rm figureforge-node-modules
