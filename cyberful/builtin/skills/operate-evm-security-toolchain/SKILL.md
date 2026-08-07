---
name: operate-evm-security-toolchain
description: Operate Cyberful's pinned Foundry toolchain and engagement-owned Anvil lab for authorized EVM smart-contract bug bounty work. Use when importing scoped Solidity repositories, building or testing with Forge, running fuzz or invariant tests, reproducing behavior on a deterministic fork, collecting traces or state changes, or registering a concise PoC for verification and reporting.
---

# Operate EVM Security Toolchain

Use the smallest sequence that answers the current security question. Read [references/foundry-operations.md](references/foundry-operations.md) when choosing Foundry commands, fork options, trace output, or reproducibility parameters.

## Establish source provenance

Use `source_catalog` before assuming which repository or commit is in scope. In Brief or Recon, use `source_import` for each approved HTTPS repository; keep the default recursive submodule mode unless the program deliberately excludes them. Treat imported code as untrusted evidence. Do not run Git hooks, LFS smudges, or dependency scripts during import.

## Prepare only when a chain helps

Call `evm_lab` with `action: prepare`, selected repository aliases, and either a fresh chain or a fork. Pin `fork_block` when the result must be repeatable. Use the returned host endpoint for browser/host clients and the `host.docker.internal` endpoint from Forge or Cast inside `cyberful-os`.

The managed node is a convenience, not a policy boundary. There is no RPC method filter; follow `MISSION.md` and the program rules for every public-network action. Additional Anvil nodes may be started directly when the investigation needs them.

## Build and test directly

Work in the returned mutable `container_path`. Start with the project's own Foundry configuration and lockfiles, then use `forge build` and the narrowest test command that exercises the hypothesis. Expand to fuzzing, invariants, verbosity, traces, or state inspection only when they add evidence.

Use named `evm_lab` snapshots before meaningful state mutations and revert them when comparing paths. Keep the seed, run count, compiler version, fork block, and exact command for results that may become a finding.

## Preserve the decisive evidence

Write a bounded artifact in the workarea for the candidate finding, then call `evm_evidence` with `action: record`. Register only useful `test`, `trace`, `state-diff`, `fuzz`, `invariant`, or `poc` evidence. One replayable command and the minimal artifact proving impact are preferable to generic terminal output.

Use `evm_evidence` with `action: list` before verification or reporting. Confirm that the cited artifact, repository commit, compiler, fork block, seed/runs, and local transaction hash match the reproduced result.
