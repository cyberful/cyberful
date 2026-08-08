# EVM runtime

Bug Bounty engagements can import pinned Solidity repositories and prepare one engagement-owned Anvil chain with `evm_lab`. The runtime uses the pinned Foundry toolchain in `cyberful-os`; Forge, Cast, Anvil, Chisel, and the shell remain directly available.

The managed lab publishes Anvil only on a random host loopback port. It returns that host/browser endpoint and a private Docker DNS endpoint for commands running inside `cyberful-os`. Each lab uses a dedicated secondary bridge and temporarily attaches the engagement core with a lower gateway priority, preserving the core's original default route; explicit stop and terminal engagement cleanup disconnect the core before removing the bridge. Anvil runs as the host's non-root identity with a read-only root filesystem, a bounded private `/tmp`, and no workarea mount. Fresh-chain bridges disable IP masquerading, while fork mode alone retains outbound networking for its selected RPC. Cyberful does not place an RPC proxy in front of either endpoint, filter JSON-RPC methods, or rewrite direct RPC traffic.

## Source collection

`source_import` is available to Bug Bounty Brief and Recon. It accepts a stable repository alias and imports at most eight roots per engagement. The default recursive mode resolves credential-free absolute or relative HTTPS submodule URLs, validates every host, checks out each exact Gitlink commit, and records a manifest v3 fingerprint for the root and every nested submodule. Hooks, redirects, LFS smudges, dependency execution, credentials, and non-HTTPS transports remain disabled. Later phases can select repositories with `source_catalog` and the optional `repository` field on source tools; they cannot add or replace imports.

Existing manifest v2 imports remain readable. Code Audit keeps its single-root collection and separate Code Graph/finding lifecycle; EVM support does not join the two workflow ledgers.

`prepare` supports a fresh chain or a fork at an optional fixed block, mutable copies of selected authenticated imports, a configurable chain ID, and synthetic accounts. Private keys are stored as redacted session variables; the tool returns their variable names and public addresses. `snapshot`, `revert`, `status`, and `stop` operate the single managed chain. Additional model-started Anvil processes are independent of this convenience lifecycle.

The Anvil container survives normal phase changes from Recon through Verify. It, its fresh-chain network, and the synthetic account variables are removed on explicit stop or engagement cleanup. Foundry commands inside `cyberful-os` receive fixed `HOME`, `FOUNDRY_DIR`, `SVM_HOME`, and `XDG_CACHE_HOME` paths beneath the engagement's `.cyberful-evm/cache` directory after caller environment processing. Compiler state is reusable across phases and is removed through the still-running core container before host cleanup rather than written to the user's profile.

Candidate finding evidence is registered explicitly with `evm_evidence`. The index at `raw/evm/evidence.json` records provenance and the SHA-256 of an existing artifact; ordinary command output and Cast calls are not archived automatically. Recording requires one unambiguous Foundry build-info file, or an explicit repository-relative `build_info` selector. Cyberful compares the supplied `solidity` expectation with the parsed compiler version and records the build-info hash, live Forge version and commit, and attested core image ID.

## Tool availability

| Tool | Bug Bounty phases |
| --- | --- |
| `source_import` | Brief, Recon |
| `source_catalog`, inventory, read, search, snapshot | All phases |
| `evm_lab` | Recon, Exploit, Hacker, Verify |
| `evm_evidence` | Recon, Exploit, Hacker, Verify, Report |

The builtin `operate-evm-security-toolchain` skill contains the concise Foundry workflow and command reference. Recon, Exploit, and Hacker persona text is not modified to force use of the EVM path.
