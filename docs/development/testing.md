# Testing and CI

Run checks from the repository root. The root `package.json` intentionally
rejects a generic test command so package-specific isolation is preserved.

| Command                 | Coverage                                             |
| ----------------------- | ---------------------------------------------------- |
| `make typecheck`        | Code-principle checks and TypeScript type checking   |
| `make test-bun`         | Application, Pi runtime, provider, and browser tests |
| `make test-python`      | cyberful-os Python unit tests                        |
| `make runtime-build`    | Native unified cyberful-os image                     |
| `make test-runtime`     | Full image, ZAP, Ghidra, bridge, and lifecycle contract |
| `make test-cyberful-os` | Real image, catalog, MCP, and gateway contract       |
| `make test-network`     | Browser socket integration                           |
| `make test-zap`         | Docker ZAP, bridge, browser proxy, scan, and cleanup |
| `make test-ghidra`      | Real Ghidra import, analysis, MCP, and restart state |
| `make docs-build`       | Strict documentation build and link validation       |

Before publishing a change, scan the checkout for secrets. This is a safety net,
not permission to place a real credential in Git history even briefly.

`make test` runs the default Bun, Python, and live cyberful-os tiers.
`make runtime-build` followed by `make test-runtime` is the complete tooling
image gate; focused ZAP and Ghidra targets reuse that image without rebuilding
separate runtimes. `make test-all` adds the remaining network contracts. Pi provider-wire,
system-message, security-block, delegation, and fallback behavior is covered by
the isolated Bun tier without requiring a live model turn.

The network tier exercises the browser socket contract. It remains outside the
default Bun tier because restricted sandboxes may forbid binding a loopback
socket.

GitHub CI runs `make typecheck test-bun test-python` and the strict documentation
build for every pull request and push to `main`. Every pull request also builds
and tests `linux/amd64` and `linux/arm64` concurrently on dedicated native
self-hosted runners; a manual `runtime.yml` run outside `main` has the same
non-publishing behavior. Pull requests and non-main manual runs upload logs
only. Main builds and pushes each native platform with BuildKit SBOM and
provenance, pulls and tests that exact published digest, assembles one OCI
index, and signs its digest through GitHub OIDC. No QEMU is installed or used.

Main runtime runs use the `runtime-main` FIFO concurrency queue. The OCI index
stores its source commit, and the next run compares from that revision so a
failed publication cannot make a later non-runtime commit copy a stale image.
When no runtime boundary changed, the workflow verifies `edge` and its Cosign
signature before copying the same digest registry-side to the new `sha-*` tag.
Before moving `edge`, a build also checks that its commit is still the live head
of `main`, so an older queued run cannot regress the tag.

Each runtime runner needs the labels `self-hosted`, `linux`,
`cyberful-container`, and its architecture (`amd64` or `arm64`), plus at least
100 GB free, Docker BuildKit/buildx, Bun, npm, Python, a C compiler, and
passwordless `sudo` for the pinned browser's Linux packages. The workflow
installs the pinned Patchright Chromium and its host libraries before the live
proxy tests; system Chrome is exercised when the runner already provides it.
The workflow does not import persistent BuildKit or Bun caches into publishable
builds; per-job BuildKit state is pruned to an 80 GB bound and then cleaned up.
