# Unified cyberful-os runtime

Cyberful uses one tooling image and exactly one tooling container per
engagement. The image combines cyberful-os, Kali tools, headless OWASP ZAP,
Firefox ESR/Xvfb, native Ghidra/PyGhidra, and all three MCP bridges.

Release builds embed an immutable multi-architecture reference:

```text
ghcr.io/cyberful/cyberful-os@sha256:<OCI-index-digest>
```

The index has native `linux/amd64` and `linux/arm64` executables. Source runs
default to the locally built `cyberful-os:latest`. `CYBERFUL_OS_IMAGE` overrides
the complete image reference in either mode.

## Engagement lifecycle

The host creates the runtime before the first phase and removes it after Report,
an error, or interruption. It carries these ownership labels:

```text
org.cyberful.managed=engagement
org.cyberful.runtime=cyberful-os
org.cyberful.session=<session-id>
```

The workarea is mounted read/write. Ghidra receives a separate, owner-only
`0700` project store; ZAP keeps its session in the container writable layer, so
it disappears with the engagement. Browser and EVM runtimes remain separate.

Pentest and Bug Bounty use normal container networking and publish only ZAP's
port 8080 as a random host-loopback port. Code Audit creates the same image
with `--network none`, never starts ZAP, and keeps Ghidra and loopback working.
Network policy is fixed when Docker creates the container and never changes at
phase handoff.

Every phase gets a fresh private gateway, but it reconnects to the same tooling
container. Phase policy decides which MCP tools are visible; service colocation
is not used as an internal security boundary.

## Supervisor

The image entrypoint is:

```text
tini -- /opt/cyberful/runtime-supervisor
```

The Python supervisor keeps the container alive, starts enabled ZAP with a
private Xvfb display, and starts Ghidra through `setpriv` with the host UID/GID
(or `1000:1000` fallback). It stores state under `/run/cyberful`. The
cyberful-os shell remains available
with the container's `NET_ADMIN` and `SYS_PTRACE` capabilities.

`TERM` is forwarded through bounded shutdown. A dead optional service is not
restarted: `/run/cyberful/status.json` becomes `degraded`, preserving the
failure instead of silently replacing its CA, API key, project, or state. The
container remains alive so surviving tools and diagnostics are still usable.

## MCP connections

The cyberful-os launcher executes tools in the received container. ZAP and
Ghidra bridges are fresh stdio processes created with `docker exec`, not
containers:

```sh
docker exec -i <container> node /opt/cyberful/zap/zap_bridge.mjs
docker exec -i <container> \
  /opt/cyberful-os-venv/bin/python /opt/cyberful/ghidra/ghidra_bridge.py
```

When `CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER=1`, the cyberful-os launcher
verifies the supplied running container, ownership labels, and workspace mount.
It cannot create, replace, or restart it. Standalone MCP use retains lazy local
container creation.

Tool discovery is derived from the live capability preflight. Required tools
remain part of the image contract, while optional tools fail closed until the
selected image proves they are installed. JEB therefore appears only for a
private image built with its licensed installer; running
`capability_attestation` refreshes the snapshot used by discovery, while
`tool_inventory` independently reports the current live availability.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CYBERFUL_OS_IMAGE` | embedded digest in releases; `cyberful-os:latest` in source | Complete unified image override |
| `CYBERFUL_OS_MCP_ENABLED` | `1` | Expose cyberful-os in eligible phases |
| `CYBER_ZAP_ENABLED` | `1` | Enable ZAP for live-target engagements |
| `CYBER_BROWSER_THROUGH_ZAP` | `1` | Chain the isolated browser through ready ZAP |
| `CYBER_ZAP_PROXY_PORT` | random loopback port | Optional fixed host-loopback port |
| `CYBER_ZAP_STARTUP_TIMEOUT_SECONDS` | `120` | ZAP readiness deadline |
| `CYBER_GHIDRA_ENABLED` | `1` | Enable the persistent Ghidra service |
| `CYBER_GHIDRA_STARTUP_TIMEOUT_SECONDS` | `300` | Ghidra readiness deadline |

Separate ZAP/Ghidra image or container variables and
`CYBERFUL_OS_AUTOSTART` are rejected by preflight. Use `CYBERFUL_OS_IMAGE`
instead of any former component-image override.

## Build and verification

The build context is `mcps/`; the Dockerfile is
`mcps/cyberful-os/Dockerfile`. Kali, ZAP, Bun, Ghidra, add-ons, and downloaded
tool archives are versioned or digest-pinned. The build fails unless Node 24,
Firefox/Xvfb, every required ZAP add-on, PyGhidra, and the architecture-native
decompiler are loadable.

```sh
make runtime-build   # build cyberful-os:latest for this host architecture
make test-runtime    # full cyberful-os, ZAP, bridge, Ghidra, and persistence contract
make test-zap        # focused ZAP tests against the existing unified image
make test-ghidra     # focused Ghidra tests against the existing unified image
```

Use `CYBERFUL_OS_IMAGE=<reference>` with the test targets to verify another
local image. Building needs at least 100 GB free; running and pulling should
start with at least 40 GB free.
