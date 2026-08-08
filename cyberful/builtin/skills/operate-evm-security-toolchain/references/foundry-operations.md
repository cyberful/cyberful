# Foundry operations

Cyberful pins Forge, Cast, Anvil, and Chisel to Foundry `v1.7.1`. Foundry may download the exact Solidity compiler required by the project. Its compiler and tool cache is engagement-local and is reused between phases until cleanup.

## Build and focused tests

Run commands from the selected repository's mutable `container_path`:

```bash
forge build --build-info
forge test --match-path 'test/Relevant*.t.sol' -vvv
forge test --match-test testSpecificBehavior -vvvv
```

Respect `foundry.toml`, remappings, profiles, and the project's chosen compiler. Keep the decisive build-info file for `evm_evidence`; when several exist, pass its repository-relative path explicitly. Do not silently upgrade dependencies or rewrite lockfiles before reproducing the original build.

## Fuzz and invariants

Prefer project configuration. Override only deliberate experiment parameters:

```bash
forge test --match-test testFuzz_Target --fuzz-runs 10000 --fuzz-seed 0x2a -vvvv
forge test --match-contract TargetInvariant --invariant-runs 256 --invariant-depth 64 -vvvv
```

Record the exact seed and run count for a result that supports a finding. A single counterexample is useful only if the same command reproduces it.

## Managed RPC and snapshots

Use the `container_rpc_url` returned by `evm_lab` from cyberful-os:

```bash
cast block-number --rpc-url "$RPC_URL"
cast call "$TARGET" 'owner()(address)' --rpc-url "$RPC_URL"
forge test --fork-url "$RPC_URL" --fork-block-number "$FORK_BLOCK" -vvvv
```

Prefer `evm_lab` named snapshots over ad hoc snapshot bookkeeping because the host records their lifecycle across phases. The tool refreshes a snapshot after revert so it can be used again.

## Traces and state evidence

Use `-vvvv` for detailed Forge traces. For a local transaction, retain its local hash and save the smallest useful trace or decoded state comparison to a workarea file. Cast supports direct calls, sends, receipts, transaction traces, storage reads, and ABI decoding; use the subcommand that makes the state or call path auditable rather than archiving every RPC response.

Never treat a successful local write as authority to write to a public network. The applicable program policy and `MISSION.md` remain the scope boundary.
