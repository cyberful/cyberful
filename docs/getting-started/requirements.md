# What you need

Cyberful brings the workflow and security tools together, but a few programs
must already be available on your computer.

| Dependency          | Requirement                                         | Purpose                            |
| ------------------- | --------------------------------------------------- | ---------------------------------- |
| Codex CLI           | Exact version in `cyberful/src/dependency/codex.ts` | Executes each workflow phase       |
| Docker with Compose | Running local engine                                | cyberful-os and headless OWASP ZAP |
| Python              | 3.10 or newer                                       | cyberful-os host bridge            |
| Node.js and npm     | Node 18 or newer                                    | npm launcher and browser MCP       |
| Bun                 | 1.3.14 for source builds only                       | Workspace build and tests          |
| Local Responses server | Optional; loopback, tool-calling compatible      | Aggressive helper and recovery     |

Verify the host before the first engagement:

```sh
cyberful --version
codex --version
docker version
docker compose version
python3 --version
node --version
```

Codex must be authenticated with `codex login`. Cyberful validates its exact
version and identity at startup; maintainers can exercise the app-server and MCP
contract without a model turn using `make test-codex`.

You do not need to configure those tools one by one. The first launch prepares
`cyberful-os:latest`, `cyberful-zap:2.17.0`, and
`cyberful-zap-bridge:0.1.0`, and may download isolated Chromium. Allow enough
disk space for those images, the browser, workarea evidence, and reports. Use a
dedicated engagement directory and keep Docker running for the full session.

The local Responses server is optional and operator-owned. Start it before
Cyberful, place `fallback-server.yaml` in the launch directory, and use a build
whose Responses API and tool calling are known to work. An unavailable server
only disables fallback for that run; an unsafe configuration stops startup.
See [Local fallback inference](../runtimes/fallback-inference.md).

For a source checkout:

```sh
make deps
make typecheck
make test-bun
```

The public `@cyberful/cli` package installs a native Cyberful binary, so most
users do not need Bun. You only need Bun when working from source.
