# What you need

The standalone Cyberful CLI requires one configured model provider and a
running Docker engine. ZAP, Ghidra, Firefox, Python, Node, and the offensive
toolchain are already inside the unified runtime image; they are not host
runtime prerequisites.

| Use case | Host requirements |
| --- | --- |
| Run a standalone release binary | Docker and one configured provider |
| Install through npm | Node.js 18+ with npm for the small platform selector, then the requirements above |
| Develop from this repository | Docker, Bun 1.3.14, Node.js 24 with npm, and Python 3.10+ |
| Build the runtime image | The development tools above and at least 100 GB free |

Check the runtime prerequisite before installing:

```sh
docker version
```

Docker Compose is not required. A host JDK, Ghidra, ZAP, Firefox, Python, Bun,
or Node installation is not required by a standalone release binary. The npm
distribution channel still uses Node for its portable platform selector; the
selected Cyberful executable and its embedded browser driver do not.

## First launch and disk capacity

The release CLI pulls one immutable multi-architecture image from
`ghcr.io/cyberful/cyberful-os`. The initial compressed download can exceed
6 GB. Keep at least **40 GB free** for the unpacked image, container writable
layer, browser, persistent Ghidra projects, workarea evidence, and reports.
Building the image from source requires at least **100 GB free**.

The image index contains native `linux/amd64` and `linux/arm64` manifests.
Docker selects the matching manifest automatically. Cyberful prints the full
image reference, selected architecture, and digest while pulling or attesting
the runtime. A local source checkout instead defaults to `cyberful-os:latest`;
build it with:

```sh
make runtime-build
```

Cyberful does not delete old local images automatically. After confirming that
no needed engagement is using them, inspect and prune images manually:

```sh
docker image ls ghcr.io/cyberful/cyberful-os
docker image prune
```

## Provider setup

The first launch creates `settings.yaml` with `openai-codex` as the main
subscription provider. Authenticate and inspect that route through Cyberful:

```sh
cyberful auth login
cyberful auth status
```

You can instead select a reviewed Z.AI or Kimi subscription adapter. Secrets
for environment-backed providers belong in the process environment or a
private `.env`, never in `settings.yaml`. See
[Agent providers and fallback](../user-guide/settings.md), then continue with
[Install Cyberful](install.md).
