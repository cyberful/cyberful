# cyberful-os

`cyberful-os` is Cyberful's multi-architecture containerized security-tool
runtime and stdio MCP bridge. Build and smoke-test it from the repository root:

```sh
mcps/cyberful-os/bin/cyberful-os-build
make test-python
make test-cyberful-os
```

The image includes Foundry `v1.7.1`: `forge`, `cast`, `anvil`, and `chisel` are
downloaded from the immutable official release, verified with its per-archive
SHA-256, and version-checked during the build for both amd64 and arm64 assets.
The MCP catalog exposes Forge, Cast, and Anvil as direct CLI tools; the shell
remains available and no runtime updater is installed.

During an EVM-capable Bug Bounty engagement, Cyberful points `HOME`,
`FOUNDRY_DIR`, `SVM_HOME`, and `XDG_CACHE_HOME` at `.cyberful-evm/cache` in the mounted workarea. Foundry may acquire
the exact Solidity compiler selected by the project on its first build and reuse
it across phases. Engagement cleanup removes this cache, so it never falls back
to the user's host profile.

The host-owned `evm_lab` lifecycle starts its Anvil node in a separate container
from this same image and publishes port 8545 only through a random loopback host
port. This is lifecycle convenience, not an RPC policy layer: Cyberful does not
proxy, filter, or rewrite JSON-RPC calls.

The generic dependency container receives the same immutable managed,
owner-process, run-owner, session, and runtime labels as engagement-scoped
containers. `cyberful-os-container up` reuses a deterministic name only when
both its image and complete ownership identity match; an unlabeled or
previous-run container is removed and recreated so interruption cleanup can
discover it reliably.
