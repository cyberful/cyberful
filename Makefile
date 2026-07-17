.PHONY: all help deps subsystems install typecheck test test-bun test-browser test-python test-cyberful-os test-network test-zap test-codex test-all build run docs docs-build clean

PYTHON ?= python3

all: typecheck test test-network build

help:
	@echo "Cyberful targets:"
	@echo "  make deps         Install workspace and MCP dependencies"
	@echo "  make subsystems   Update, verify, and pin registered host subsystems"
	@echo "  make typecheck    Type-check the workspace"
	@echo "  make test         Run Bun, Python, and the live Docker cyberful-os contract"
	@echo "  make test-bun     Run the isolated application and browser MCP Bun tests"
	@echo "  make test-browser Run the browser MCP boundary and ownership tests"
	@echo "  make test-python  Run the cyberful-os Python unit tests"
	@echo "  make test-cyberful-os Build and verify the real cyberful-os image, MCP, and gateway"
	@echo "  make test-network Run loopback/socket integration tests"
	@echo "  make test-zap     Run the real Docker ZAP, bridge, browser, scan, and cleanup suite"
	@echo "  make test-codex   Verify the installed Codex satisfies cyberful's contract (no account needed)"
	@echo "  make test-all     Run local, network, ZAP, and Codex contract suites"
	@echo "  make build        Build standalone binaries for all platforms (gated on test-codex)"
	@echo "  make install      Build and install the 'cyberful' command for this system"
	@echo "  make run          Launch Cyberful from the repository root"
	@echo "  make docs         Serve the engineer docs locally"
	@echo "  make docs-build   Build the static documentation site"
	@echo "  make clean        Remove generated build and documentation output"

deps:
	bun install
	cd mcps && npm install

# Discover each registered subsystem release, install and verify it, then persist its exact
# runtime and CI pins. Documentation is never consulted. Limit with `SUBSYSTEMS=codex`.
subsystems:
	bun run cyberful/script/subsystems.ts $(SUBSYSTEMS)

typecheck:
	bun run typecheck

# Tests execute from their package directories; the repository root intentionally remains guarded.
test: test-bun test-python test-cyberful-os
	@echo
	@echo "╭──────────────────────────────────────────────────────────────────────╮"
	@echo "│ CYBERFUL TEST SUMMARY                                                │"
	@echo "├──────────────────────────────────────────────────────────────────────┤"
	@echo "│ [✓] Application and browser MCP Bun tests                            │"
	@echo "│ [✓] cyberful-os Python unit tests                                       │"
	@echo "│ [✓] Live image and required capability attestation                   │"
	@echo "│ [✓] Core, audit, cloud, Kubernetes, and fuzzing startup probes       │"
	@echo "│ [✓] cyberful-os MCP inventory and phase-gateway exposure                │"
	@echo "├──────────────────────────────────────────────────────────────────────┤"
	@echo "│ [✓] ALL DEFAULT TESTS PASSED                                         │"
	@echo "╰──────────────────────────────────────────────────────────────────────╯"

test-bun:
	bun run --cwd cyberful test
	$(MAKE) test-browser

test-browser:
	cd mcps && bun run test:browser

test-python:
	cd mcps/cyberful-os && $(PYTHON) -m unittest discover -s tests -v

test-cyberful-os:
	@docker version --format '{{.Server.Version}}' >/dev/null || (echo "Docker is required for make test-cyberful-os; start Docker and retry." >&2; exit 1)
	@mcps/cyberful-os/bin/cyberful-os-build --quiet
	bun run --cwd cyberful test:cyberful-os

test-network:
	bun run --cwd cyberful test:network

test-zap:
	bun run --cwd cyberful test:zap

# Verify the installed Codex CLI satisfies cyberful's phase contract: the pinned version, the
# `--strict-config` config keys, the app-server JSON-RPC handshake, and the MCP spawn->connect->tools/list
# round-trip. Needs Codex on PATH but NOT a logged-in account. `make build`/`make install` run it too.
test-codex:
	bun run --cwd cyberful test-codex

test-all: test test-network test-zap test-codex

# Build standalone binaries for every supported platform (macOS, Linux, Windows).
build:
	bun run build

# Build the current platform's binary and install the `cyberful` command for this user
# (into ~/.cyberful/bin, added to PATH). On Windows, where make is usually absent, run the
# script directly: bun run cyberful/script/install.ts
install:
	bun run cyberful/script/install.ts

# Launch at the repository root so the `work/`, `logs/`, and `reports/` runtime
# dirs are created here. The source bootstrap selects cyberful/builtin;
# the app layers `.env` itself, so no --env-file is needed.
run:
	cd $(dir $(abspath $(firstword $(MAKEFILE_LIST)))) && CYBERFUL_BUILD_ID="$${CYBERFUL_BUILD_ID:-$$(bun ./cyberful/script/source-build-id.ts)}" bun --preload ./cyberful/node_modules/@opentui/solid/scripts/preload.ts --conditions=browser cyberful/src/index.ts $(ARGS)

docs:
	cd $(dir $(abspath $(firstword $(MAKEFILE_LIST)))) && ./scripts/serve-docs.sh

docs-build:
	cd $(dir $(abspath $(firstword $(MAKEFILE_LIST)))) && ./scripts/serve-docs.sh build

clean:
	rm -rf site dist ts-dist cyberful/dist
