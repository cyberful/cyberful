.PHONY: all help deps install typecheck test test-bun test-browser test-python runtime-build test-runtime test-cyberful-os test-network test-zap test-ghidra test-all build run cve_dictionary cve_dictionary_publish browser-run-1 browser-run-2 browser-run-3 browser-run-4 browser-run-5 docs docs-build clean

PYTHON ?= python3
CYBERFUL_OS_IMAGE ?= cyberful-os:latest
CVE_DICTIONARY_DEFINITION ?= cyberful/data/cve-dictionary/sources.json
CVE_DICTIONARY_OUTPUT ?= dist/cve-dictionary
CVE_DICTIONARY_OFFLINE ?= 0
CVE_DICTIONARY_MODEL_CACHE ?= .cache/cve-dictionary/models
CVE_DICTIONARY_GOLDEN_SET ?= cyberful/data/cve-dictionary/golden-queries.json
CVE_DICTIONARY_PUBLISH_REPOSITORY ?= cyberful/cyberful
CVE_DICTIONARY_PUBLISH_DRY_RUN ?= 0

all: typecheck test test-network build

help:
	@echo "Cyberful targets:"
	@echo "  make deps         Install workspace and MCP dependencies"
	@echo "  make typecheck    Type-check the workspace"
	@echo "  make test         Run Bun, Python, and the live Docker cyberful-os contract"
	@echo "  make test-bun     Run the isolated application and browser MCP Bun tests"
	@echo "  make test-browser Run the browser MCP boundary and ownership tests"
	@echo "  make test-python  Run the cyberful-os Python unit tests"
	@echo "  make runtime-build Build the native unified cyberful-os image"
	@echo "  make test-runtime Attest the existing unified image, ZAP, and Ghidra end to end"
	@echo "  make test-cyberful-os Build and verify the real cyberful-os image, MCP, and gateway"
	@echo "  make test-network Run loopback/socket integration tests"
	@echo "  make test-zap     Run the real Docker ZAP, bridge, browser, scan, and cleanup suite"
	@echo "  make test-ghidra  Run Ghidra host/MCP tests plus real persistence and restart checks"
	@echo "  make test-all     Run local, network, ZAP, and Ghidra contract suites"
	@echo "  make build        Build standalone binaries for all platforms"
	@echo "  make install      Build and install the 'cyberful' command for this system"
	@echo "  make run          Launch Cyberful from the repository root"
	@echo "  make cve_dictionary Rebuild the pinned offline CVE dictionary and its manifests"
	@echo "  make cve_dictionary_publish Sign and publish the verified local CVE snapshot"
	@echo "  make browser-run-{1..5} Open a persistent browser profile for target pre-authentication"
	@echo "  make docs         Serve the engineer docs locally"
	@echo "  make docs-build   Build the static documentation site"
	@echo "  make clean        Remove generated build and documentation output"

deps:
	bun install
	cd mcps && npm install

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

runtime-build:
	@docker version --format '{{.Server.Version}}' >/dev/null || (echo "Docker is required for make runtime-build; start Docker and retry." >&2; exit 1)
	@mcps/cyberful-os/bin/cyberful-os-build

test-runtime:
	@docker version --format '{{.Server.Version}}' >/dev/null || (echo "Docker is required for make test-runtime; start Docker and retry." >&2; exit 1)
	@docker image inspect '$(CYBERFUL_OS_IMAGE)' >/dev/null || (echo "Runtime image $(CYBERFUL_OS_IMAGE) is missing; run make runtime-build first." >&2; exit 1)
	CYBERFUL_OS_IMAGE='$(CYBERFUL_OS_IMAGE)' bun run --cwd cyberful test:cyberful-os
	CYBERFUL_OS_IMAGE='$(CYBERFUL_OS_IMAGE)' bun run --cwd cyberful test:zap
	$(PYTHON) -m unittest discover -s mcps/ghidra/tests -p 'test_*.py' -v
	CYBERFUL_OS_IMAGE='$(CYBERFUL_OS_IMAGE)' $(PYTHON) mcps/ghidra/tests/integration_test.py -v

test-cyberful-os: runtime-build
	bun run --cwd cyberful test:cyberful-os

test-network:
	bun run --cwd cyberful test:network

test-zap:
	@docker image inspect '$(CYBERFUL_OS_IMAGE)' >/dev/null || (echo "Runtime image $(CYBERFUL_OS_IMAGE) is missing; run make runtime-build first." >&2; exit 1)
	CYBERFUL_OS_IMAGE='$(CYBERFUL_OS_IMAGE)' bun run --cwd cyberful test:zap

test-ghidra:
	@docker version --format '{{.Server.Version}}' >/dev/null || (echo "Docker is required for make test-ghidra; start Docker and retry." >&2; exit 1)
	@docker image inspect '$(CYBERFUL_OS_IMAGE)' >/dev/null || (echo "Runtime image $(CYBERFUL_OS_IMAGE) is missing; run make runtime-build first." >&2; exit 1)
	bun --cwd cyberful test --isolate src/ghidra-store.test.ts src/dependency/config.test.ts src/subsystem/upstream.test.ts src/subsystem/gateway/phase-policy.test.ts src/subsystem/gateway/ghidra-evidence.test.ts
	$(PYTHON) -m unittest discover -s mcps/ghidra/tests -p 'test_*.py' -v
	CYBERFUL_OS_IMAGE='$(CYBERFUL_OS_IMAGE)' $(PYTHON) mcps/ghidra/tests/integration_test.py -v

test-all: test test-network test-zap test-ghidra

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

# Materialize only immutable revisions declared in the source registry, then
# rebuild SQLite, FTS/vector indexes, coverage, manifests, checksums, and gzip.
cve_dictionary:
	bun cyberful/script/cve-dictionary-sources.ts --definition "$(CVE_DICTIONARY_DEFINITION)" --offline "$(CVE_DICTIONARY_OFFLINE)"
	bun cyberful/script/cve-dictionary-build.ts --definition "$(CVE_DICTIONARY_DEFINITION)" --output "$(CVE_DICTIONARY_OUTPUT)" --model-cache "$(CVE_DICTIONARY_MODEL_CACHE)" --golden-set "$(CVE_DICTIONARY_GOLDEN_SET)" --offline "$(CVE_DICTIONARY_OFFLINE)"

# Maintainer-only release path. It never rebuilds the corpus: it signs the exact
# completed local snapshot, validates its documented assets, and creates one
# immutable GitHub release after explicit invocation.
cve_dictionary_publish:
	bun cyberful/script/cve-dictionary-release.ts --definition "$(CVE_DICTIONARY_DEFINITION)" --output "$(CVE_DICTIONARY_OUTPUT)" --repository "$(CVE_DICTIONARY_PUBLISH_REPOSITORY)" --dry-run "$(CVE_DICTIONARY_PUBLISH_DRY_RUN)"

browser-run-1 browser-run-2 browser-run-3 browser-run-4 browser-run-5:
	bun cyberful/script/browser-run.ts $(@:browser-run-%=%)

docs:
	cd $(dir $(abspath $(firstword $(MAKEFILE_LIST)))) && ./scripts/serve-docs.sh

docs-build:
	cd $(dir $(abspath $(firstword $(MAKEFILE_LIST)))) && ./scripts/serve-docs.sh build

clean:
	rm -rf site dist ts-dist cyberful/dist
