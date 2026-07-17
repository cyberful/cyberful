# Testing and CI

Run checks from the repository root. The root `package.json` intentionally
rejects a generic test command so package-specific isolation is preserved.

| Command                 | Coverage                                             |
| ----------------------- | ---------------------------------------------------- |
| `make typecheck`        | Code-principle checks and TypeScript type checking   |
| `make test-bun`         | Application and browser MCP unit tests               |
| `make test-python`      | cyberful-os Python unit tests                        |
| `make test-cyberful-os` | Real image, catalog, MCP, and gateway contract       |
| `make test-network`     | Loopback and socket integration behavior             |
| `make test-zap`         | Docker ZAP, bridge, browser proxy, scan, and cleanup |
| `make test-codex`       | Pinned Codex app-server and MCP compatibility        |
| `make docs-build`       | Strict documentation build and link validation       |

CI also scans every checkout with a checksum-verified Gitleaks binary before
running the quality suite. This is a safety net, not permission to place a real
credential in Git history even briefly.

`make test` runs the default Bun, Python, and live cyberful-os tiers;
`make test-all` adds network, ZAP, and Codex contracts.

Pull requests and `main` run the same verification stages in GitHub Actions.
Native package builds begin only after verification succeeds. The aggregate
`CI / required` job is the branch-protection target; individual matrix jobs
remain useful diagnostics.
