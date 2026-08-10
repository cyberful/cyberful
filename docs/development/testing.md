# Testing and CI

Run checks from the repository root. The root `package.json` intentionally rejects a generic test command so package-specific isolation is preserved.

| Command | Coverage |
| --- | --- |
| `make typecheck` | Code-principle checks and TypeScript type checking |
| `make test-bun` | Application, Pi runtime, provider, and browser tests |
| `make test-python` | cyberful-os Python and native-laboratory unit tests |
| `make runtime-build` | Native unified cyberful-os image for the host architecture |
| `make test-runtime` | Full image, ZAP, Ghidra, bridge, lifecycle, and capability contract |
| `make test-cyberful-os` | Real image, catalog, MCP, and gateway contract |
| `make test-network` | Browser socket integration |
| `make test-zap` | Docker ZAP, bridge, browser proxy, scan, and cleanup |
| `make test-ghidra` | Real Ghidra import, analysis, MCP, and restart state |
| `make docs-build` | Strict documentation build and link validation |

Before publishing a change, scan the checkout for secrets. This is a safety net, not permission to place a real credential in Git history even briefly.

`make test` runs the default Bun, Python, and live cyberful-os tiers. `make runtime-build` followed by `make test-runtime` is the complete tooling image gate; focused ZAP and Ghidra targets reuse that image. `make test-all` adds the remaining network contracts. Pi provider-wire, system-message, security-block, delegation, and fallback behavior is covered by the isolated Bun tier without requiring a live model turn.

`make test-browser` validates DuckDuckGo URL construction and static HTML parsing without network access. `CYBERFUL_TEST_LIVE_DUCKDUCKGO=1 make test-browser` additionally runs the opt-in live Chromium probe; it is intentionally absent from ordinary CI because external availability and markup are not release-controlled.

GitHub CI runs `make typecheck test-bun test-python` and the strict documentation build for every pull request and push to `main`. CI never builds, publishes, promotes, signs, or pulls a first-party Cyberful container image. Release jobs build only native CLI packages and verify the embedded runtime context manifest and fingerprint.

Runtime-image verification is deliberately local. Contributors run `make runtime-build make test-runtime` on a trusted amd64 or arm64 Docker host when the Dockerfile, runtime launchers, MCP registry, bridges, or tool dependencies change. Full-system QEMU, binfmt registration, Apple/iOS tooling, physical Android bridges, and an unlicensed JEB installation are outside this runtime contract.

The local image build needs at least 100 GB free. BuildKit output is printed live. Installed release binaries additionally retain a private build log and expose `cyberful runtime status`, `cyberful runtime build --force`, and `cyberful runtime prune` for diagnosis and lifecycle control.
