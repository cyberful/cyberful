# Testing and CI

Run checks from the repository root. The root `package.json` intentionally
rejects a generic test command so package-specific isolation is preserved.

| Command                 | Coverage                                             |
| ----------------------- | ---------------------------------------------------- |
| `make typecheck`        | Code-principle checks and TypeScript type checking   |
| `make test-bun`         | Application and browser MCP unit tests               |
| `make test-python`      | cyberful-os Python unit tests                        |
| `make test-cyberful-os` | Real image, catalog, MCP, and gateway contract       |
| `make test-network`     | Browser sockets and local Responses recovery          |
| `make test-zap`         | Docker ZAP, bridge, browser proxy, scan, and cleanup |
| `make test-codex`       | Pinned Codex app-server and MCP compatibility        |
| `make docs-build`       | Strict documentation build and link validation       |

Before publishing a change, scan the checkout for secrets. This is a safety net,
not permission to place a real credential in Git history even briefly.

`make test` runs the default Bun, Python, and live cyberful-os tiers;
`make test-all` adds network, ZAP, and Codex contracts.

The fallback network tier starts a real loopback Responses fixture, confirms
preflight and tool calling, injects a terminal `cyberPolicy` failure, and checks
that local recovery completes the phase. It is kept out of the default Bun tier
because restricted sandboxes may forbid binding a loopback socket.

GitHub CI/CD is temporarily disabled. Until it is activated, maintainers run the
relevant commands above locally and record which checks passed. The workflow
definitions remain in `.github/workflows` with a `.disabled` suffix.
