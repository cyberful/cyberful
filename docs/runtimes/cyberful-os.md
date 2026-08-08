# Unified cyberful-os runtime

Cyberful uses one tooling image with two runtime roles for live-target engagements. The core container owns cyberful-os, Kali tools, and optional Ghidra; a dedicated, less-privileged container owns headless OWASP ZAP and Firefox/Xvfb. Code Audit starts only the offline core role. Both roles use the same attested image and remain engagement-scoped.

Release builds embed an immutable multi-architecture reference:

```text
ghcr.io/cyberful/cyberful-os@sha256:<OCI-index-digest>
```

The index has native `linux/amd64` and `linux/arm64` executables. Source runs default to the locally built `cyberful-os:latest`. `CYBERFUL_OS_IMAGE` overrides the complete image reference in either mode.

## Engagement lifecycle

The host creates the runtime roles before the first phase and removes them after Report, an error, or interruption. The core role carries these ownership labels:

```text
org.cyberful.managed=engagement
org.cyberful.runtime=cyberful-os
org.cyberful.session=<session-id>
```

The ZAP role uses the same session and managed labels with `org.cyberful.runtime=cyberful-zap`, so label-based terminal cleanup proves both are absent.

The workarea is mounted read/write. Ghidra receives a separate, owner-only `0700` project store. Each session binds ZAP's named session, private CA key, and home to an opaque owner-only child under `raw/zap/runtime/` so controlled recovery preserves its identity and concurrent sessions cannot share the same ZAP home. The core masks the entire runtime subtree with a nested private tmpfs, so even its root shell cannot read any ZAP private key. The matching child under `raw/zap/trust/` contains only that session's attested public certificate and combined CA bundle and is mounted read-only at `/run/cyberful/proxy-trust`. Browser and EVM runtimes remain separate.

Pentest and Bug Bounty use normal container networking and publish only the dedicated ZAP container's port 8080 as a random host-loopback port. The core retains the capabilities required by the security toolchain and receives a mild relative OOM preference (`oom_score_adj=250`); ZAP receives neither those capabilities nor that adjustment, which makes it less likely to be selected before an expendable core workload under pressure. Code Audit creates the same image as an offline core with `--network none`, never starts ZAP, and keeps Ghidra and loopback working. Network policy is fixed when Docker creates each role and never changes at phase handoff.

Every phase gets a fresh private gateway. cyberful-os and Ghidra reconnect to the core container; ZAP reconnects to its dedicated container. Phase policy decides which MCP tools are visible.

## Supervisor

The image entrypoint is:

```text
tini -- /opt/cyberful/runtime-supervisor
```

The Python supervisor keeps the container alive, starts enabled ZAP with a private Xvfb display, and starts Ghidra through `setpriv` with the host UID/GID (or `1000:1000` fallback). It stores state under `/run/cyberful`. The cyberful-os shell remains available with the container's `NET_ADMIN` and `SYS_PTRACE` capabilities.

`TERM` is forwarded through bounded shutdown. A dead optional service is not restarted autonomously: `/run/cyberful/status.json` becomes `degraded`, preserving the failure instead of silently replacing its CA, API key, project, or state. For ZAP only, the host can explicitly signal a session-preserving restart or a new named session generation after a failed phase preflight. The supervisor continuously records health, restart count, generation, exit signal, and bounded cgroup-v2 memory counters.

## MCP connections

The cyberful-os launcher executes tools in the received container. ZAP and Ghidra bridges are fresh stdio processes created with `docker exec`, not containers:

```sh
docker exec -i <zap-container> node /opt/cyberful/zap/zap_bridge.mjs
docker exec -i <core-container> \
  /opt/cyberful-os-venv/bin/python /opt/cyberful/ghidra/ghidra_bridge.py
```

When `CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER=1`, the cyberful-os launcher verifies the supplied running container, ownership labels, and workspace mount. It cannot create, replace, or restart it. For live-target phases the gateway also requires the host-owned proxy and CA bundle as an indivisible pair. Host processes and browsers use ZAP's random loopback publication, while commands inside the core use the dedicated ZAP container's private Docker DNS endpoint on the shared engagement network; they do not route a host-loopback port back through Docker's host gateway. The launcher validates the regular, bounded bundle under `/run/cyberful/proxy-trust`, then applies it after tool-provided environment values as `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`, `NODE_EXTRA_CA_CERTS`, and `BUNDLE_SSL_CA_CERT`; it also enforces `GIT_SSL_NO_VERIFY=false`, `NODE_USE_ENV_PROXY=1`, and `BUNDLE_SSL_VERIFY_MODE=1`. Tool-provided environment values therefore cannot disable trust for curl/OpenSSL, Git HTTPS, Requests/pip, Node, or Ruby/Bundler. Standalone MCP use retains lazy local container creation.

The host exports ZAP's public root certificate from the local API and accepts it only as one currently valid, self-issued, cryptographically self-signed CA with no private-key block. Both its certificate SHA-256 fingerprint and SPKI SHA-256 are retained. A minimal owner-only `attestation.json` persists those identifiers and the bundle digest beside the public material, so a complete control-plane restart reloads the expected identity instead of silently trusting a replacement. The system CA bundle is copied through a temporary host directory, combined with only that public certificate, atomically installed with owner-only permissions, and removed from temporary storage. Every phase verifies the expected path, regular-file type, digest, certificate inclusion, and OpenSSL chain. One regeneration is allowed for missing or corrupt trust material; a second failure blocks the worker as `required_upstream_unavailable`. Preserve recovery requires both identifiers to remain unchanged, while reset recovery may rotate them and atomically replace the durable anchor only after the replacement bundle has passed the same attestation.

Tool discovery is derived from the live capability preflight. Required tools remain part of the image contract, while optional tools fail closed until the selected image proves they are installed. JEB therefore appears only for a private image built with its licensed installer; running `capability_attestation` refreshes the snapshot used by discovery, while `tool_inventory` independently reports the current live availability.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CYBERFUL_OS_IMAGE` | embedded digest in releases; `cyberful-os:latest` in source | Complete unified image override |
| `CYBERFUL_OS_MCP_ENABLED` | `1` | Expose cyberful-os in eligible phases |
| `CYBER_ZAP_ENABLED` | `1` | Enable ZAP for live-target engagements |
| `CYBER_BROWSER_THROUGH_ZAP` | `1` | Chain the isolated browser through ready ZAP |
| `CYBER_ZAP_PROXY_PORT` | random loopback port | Optional fixed host-loopback port |
| `CYBER_ZAP_STARTUP_TIMEOUT_SECONDS` | `120` | Combined ZAP API and MCP readiness deadline |
| `CYBER_GHIDRA_ENABLED` | `1` | Enable the persistent Ghidra service |
| `CYBER_GHIDRA_STARTUP_TIMEOUT_SECONDS` | `300` | Ghidra readiness deadline |

`CYBERFUL_OS_CA_BUNDLE` and `CYBERFUL_OS_HTTP_PROXY` are internal host-owned interfaces, not operator overrides. Neither is exposed to a phase until trust preflight succeeds.

Separate image overrides and `CYBERFUL_OS_AUTOSTART` are rejected by preflight. The host-owned `CYBERFUL_ZAP_RUNTIME_CONTAINER` routing value is internal and is not an operator override. Use `CYBERFUL_OS_IMAGE` for both roles instead of any former component-image override.

## Build and verification

The build context is `mcps/`; the Dockerfile is `mcps/cyberful-os/Dockerfile`. Kali, ZAP, Bun, Ghidra, add-ons, and downloaded tool archives are versioned or digest-pinned. The build fails unless Node 24, Firefox/Xvfb, every required ZAP add-on, PyGhidra, and the architecture-native decompiler are loadable.

```sh
make runtime-build   # build cyberful-os:latest for this host architecture
make test-runtime    # full cyberful-os, ZAP, bridge, Ghidra, and persistence contract
make test-zap        # focused ZAP tests against the existing unified image
make test-ghidra     # focused Ghidra tests against the existing unified image
```

Use `CYBERFUL_OS_IMAGE=<reference>` with the test targets to verify another local image. Building needs at least 100 GB free; running and pulling should start with at least 40 GB free.
