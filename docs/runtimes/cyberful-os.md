# cyberful-os

`cyberful-os` is Cyberful's containerized security-tool runtime. The host starts
the stdio MCP server through `mcps/cyberful-os/bin/cyberful-os`, while the
phase gateway decides which tools a workflow phase may use and whether the
container receives a network route.

## Runtime identity

The public runtime identity is consistent across local development and release
builds:

| Resource          | Name                         |
| ----------------- | ---------------------------- |
| Toolkit directory | `mcps/cyberful-os`           |
| MCP launcher      | `cyberful-os`                |
| Image             | `cyberful-os:latest`         |
| Default container | `cyberful-os`                |
| MCP gateway key   | `cyberful-os`                |
| Local state root  | `~/.local/state/cyberful-os` |

Cyberful stores and publishes the complete image reference as
`cyberful-os:latest`.

## Commands

From the repository root:

```sh
mcps/cyberful-os/bin/cyberful-os-build
mcps/cyberful-os/bin/cyberful-os-container up
mcps/cyberful-os/bin/cyberful-os-container status
mcps/cyberful-os/bin/cyberful-os-container shell
mcps/cyberful-os/bin/cyberful-os-container down
```

`make test-python` runs the MCP unit tests. `make test-cyberful-os` builds the
real image and verifies its capability catalog through both the MCP server and
the phase gateway.

The MCP catalog is the single source for both `tools/list` and `tools/call`.
Every published lowercase tool name has one schema and one handler. The
`shell` fallback keeps its bounded command, workdir, timeout, output, environment,
and optional egress-metadata contract; dedicated argv tools remain preferred.

## Foundry

The multi-architecture image installs `forge`, `cast`, `anvil`, and `chisel`
from the immutable Foundry `v1.7.1` release. The build downloads the official
per-archive SHA-256 file for `linux_amd64` or `linux_arm64`, verifies it before
extraction, and checks every binary's reported version. `foundryup` is not
installed or run at runtime.

Foundry's normal compiler auto-detection remains enabled so the first project
build can download its exact Solidity compiler. In EVM-capable Bug Bounty runs,
`HOME`, `FOUNDRY_DIR`, `SVM_HOME`, and `XDG_CACHE_HOME` point under
`.cyberful-evm/cache` in the engagement mount. Redirecting `HOME` is required by
the pinned compiler manager and makes a downloaded `solc` reusable by a later
offline container. The cache is reused across phases, never written to the
host's global profile, and removed by engagement cleanup.

## Nuclei execution

`nuclei` exposes the complete ProjectDiscovery CLI. Cyberful injects only
`-disable-update-check` to prevent product telemetry; it adds no template,
rate, concurrency, redirect, OAST, tag, marker, or workflow limits.
`nuclei_templates` is an optional offline preview of the installed template
corpus and is never required before a run. Mission and effect policy apply to
Nuclei exactly as they apply to every other tool.

## Passive egress observation

The `shell` tool accepts an optional metadata hint for network-bearing PoCs. It
executes the command first, then attaches a redacted observation containing the
host, method, path family, byte counts, attempts, redirects, deadline, actual
route, and whether the destination differed from the hint. URL user information,
queries, fragments, headers, credentials, and bodies are never written to this
ledger. Dynamic, personal, and opaque path identifiers are collapsed to a path
family.

Observation is deliberately fail-open and is not an enforcement proxy. It does
not compare the destination with an allowlist and cannot block, rewrite, reroute,
retry, delay, or cancel a request, including when a script selects a different
host. If extraction or persistence fails, the original tool result is returned
and the gateway records degraded observability when it can. The standalone
`egress_observation` tool lets a phase append richer post-execution metadata; it
also never controls network execution. Mission scope and safety policy remain
separate from this telemetry. Missing metadata never causes a retry.

The gateway merges these local-only fields into
`raw/operations/tool-usage.csv`. No observation is exported from the machine,
and missing fields remain empty rather than being inferred as proof. Tool
failures are the exception to empty classification: every `outcome=error` row
has one controlled `error_class`, with separate `error_code` and
`tool_exit_code` columns when available. Arguments, output, and sensitive
failure detail remain outside the CSV.

## Configuration

| Variable                    | Purpose                                      | Default                          |
| --------------------------- | -------------------------------------------- | -------------------------------- |
| `CYBERFUL_OS_DIR`           | Toolkit root used by the host                | Bundled or in-repository toolkit |
| `CYBERFUL_OS_AUTOSTART`     | Start the managed container during bootstrap | `1`                              |
| `CYBERFUL_OS_MCP_ENABLED`   | Expose the MCP server to eligible phases     | `1`                              |
| `CYBERFUL_OS_IMAGE`         | Docker image name                            | `cyberful-os:latest`             |
| `CYBERFUL_OS_CONTAINER`     | Docker container name                        | `cyberful-os`                    |
| `CYBERFUL_OS_WORKSPACE`     | Host directory mounted into the container    | Current workspace                |
| `CYBERFUL_OS_MOUNT`         | Container-side workspace path                | `/workspace`                     |
| `CYBERFUL_OS_DOCKER_ARGS`   | Additional bounded Docker run arguments      | Empty                            |
| `CYBERFUL_OS_DOCKER_CONFIG` | Isolated Docker CLI state directory          | Under the cyberful-os state root |

The runtime has no legacy environment aliases. Use only the `CYBERFUL_OS_*`
contract shown above.

## Lifecycle and isolation

The first eligible tool call creates or starts the named container, validates
its workspace mount, and reuses it for the owning engagement. Every sequential
phase receives a fresh in-process Pi worker owner and private gateway; the
current owner shuts down and the gateway exits before the successor starts.
Offline phases add `--network=none`, and all tool output is bounded and
sanitized before it reaches the MCP client.

Every engagement container, including the shared dependency container named
`cyberful-os`, carries immutable `managed`, `owner-pid`, `run-owner`, `session`,
and `runtime` labels. An existing deterministic name is reused only when both
its image identity and all ownership labels match; otherwise Cyberful recreates
it instead of adopting a previous run's container.

Normal session completion removes its exact deterministic Expert names and
performs three bounded Docker inventory/removal passes using the immutable
session and run-owner labels. Only a final empty inventory records the session
as `closed`; a survivor or inventory failure records
`closed_with_cleanup_errors` in `raw/operations/run-state.json` and fails the
lifecycle. A process-scoped shared dependency may remain until its owning worker
shuts down, but it cannot be adopted by another owner because its complete
label set must match.

On TUI shutdown, Cyberful first asks the in-process Pi owner to close its
AgentRun tree and gateway bridge. If the outer worker exceeds its two-minute
teardown window, the terminal terminates that process and immediately handles
the exact last-known container snapshot before awaiting Docker label discovery.
A final run-label retry covers a late container missing from the worker's last
inventory. The ownership filter prevents cleanup from affecting containers
belonging to another concurrent run.

The image build pins its base and installed capability catalog in
`mcps/cyberful-os/Dockerfile`. Runtime code and user-facing metadata refer only
to the `cyberful-os` identity.

## Imported source execution

Phases use the native host shell only for static analysis of imported source.
Dependency installation, builds, tests, scripts, binaries, and services run
through the cyberful-os `shell` MCP tool. The active workarea maps to
`/workspace` inside the container, so container paths derive from
workarea-relative paths without embedding host-specific directories. Network
remains available according to the active workflow and `MISSION.md`.
