# What you need

Cyberful brings the workflow and security tools together, but a few programs
must already be available on your computer.

| Dependency          | Requirement                   | Purpose                           |
| ------------------- | ----------------------------- | --------------------------------- |
| Model provider      | At least one configured route | Inference for Pi Agent runs       |
| Docker with Compose | Running local engine          | cyberful-os, ZAP, Ghidra, and EVM |
| Python              | 3.10 or newer                 | cyberful-os host bridge           |
| Node.js and npm     | Node 18 or newer              | npm launcher and browser MCP      |
| Bun                 | 1.3.14 for source builds only | Workspace build and tests         |

Verify the prerequisites before installing Cyberful:

```sh
docker version
docker compose version
python3 --version
node --version
```

The first launch creates `settings.yaml` with `openai-codex` as the main
subscription provider. Authenticate and inspect that configured key through Cyberful:

```sh
cyberful auth login
cyberful auth status
```

You can instead select the reviewed Z.AI or Kimi subscription adapters and run
`cyberful auth login <name>`, where `<name>` is the key under
`agent.providers`. Environment-backed providers require only the variable name
in `settings.yaml`; place the actual secret in the process environment or `.env`. See
[Agent providers and fallback](../user-guide/settings.md).

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
