# What you need

Cyberful brings the workflow and security tools together, but a few programs
must already be available on your computer.

| Dependency          | Requirement                                         | Purpose                            |
| ------------------- | --------------------------------------------------- | ---------------------------------- |
| Codex CLI           | Exact version in `cyberful/src/dependency/codex.ts` | Executes each workflow phase       |
| Docker with Compose | Running local engine                                | cyberful-os, ZAP, Ghidra, and EVM  |
| Python              | 3.10 or newer                                       | cyberful-os host bridge            |
| Node.js and npm     | Node 18 or newer                                    | npm launcher and browser MCP       |
| Bun                 | 1.3.14 for source builds only                       | Workspace build and tests          |

Verify the prerequisites before installing Cyberful:

```sh
codex --version
docker version
docker compose version
python3 --version
node --version
```

Codex must be authenticated with `codex login`. Cyberful validates its exact
version and identity at startup; maintainers can exercise the app-server and MCP
contract without a model turn using `make test-codex`.

Continue with [Install Cyberful](install.md) when these prerequisites are ready.

## First-launch capacity

You do not need to configure those tools one by one. The first launch prepares
`cyberful-os:latest`, `cyberful-zap:2.17.0`,
`cyberful-zap-bridge:0.1.0`, `cyberful-ghidra:12.1.2`, and
`cyberful-ghidra-bridge:0.1.0`, and may download isolated Chromium. Ghidra uses
JDK 21 inside its image; no host Java installation is required. Allow enough
disk space for those images, persistent Ghidra projects, the browser, workarea
evidence, and reports. Use a
dedicated engagement directory and keep Docker running for the full session.
