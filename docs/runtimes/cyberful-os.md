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

## Controlled Nuclei execution

`nuclei_plan` accepts one authorized absolute HTTP or HTTPS target and a
structured tag, template ID, or severity filter. It rejects credentials, URL
fragments, empty filters, and selections above 40 templates without sending
target traffic. `nuclei_run_scoped` then consumes the plan once with redirects
and OAST disabled, concurrency and bulk size fixed to one, and the request rate
capped at five per second.

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
phase receives a fresh Codex process and private gateway; the current gateway
and process exit before the successor starts. Offline phases add
`--network=none`, and all tool output is bounded and sanitized before it reaches
the MCP client.

The image build pins its base and installed capability catalog in
`mcps/cyberful-os/Dockerfile`. Runtime code and user-facing metadata refer only
to the `cyberful-os` identity.
