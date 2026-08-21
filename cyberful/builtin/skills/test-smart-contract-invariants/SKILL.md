---
name: test-smart-contract-invariants
description: Test executable smart-contract properties with deterministic, offline Foundry harnesses over a confined source snapshot. Use when an authorization, accounting, state-machine, upgrade, token, oracle, or economic hypothesis can be expressed as a fuzz, invariant, or regression test.
metadata:
  domain: application-security
  subdomain: smart-contract-invariant-testing
  triggers:
    - test smart contract invariants
    - Foundry invariant harness
    - Solidity fuzz property test
    - reproduce contract accounting failure
    - smart contract regression proof
  tags:
    - smart-contracts
    - Solidity
    - Foundry
    - invariant-testing
    - fuzzing
    - regression
  frameworks:
    nist_csf:
      - PR.PS
      - ID.RA
---

# Test Smart Contract Invariants

Turn one supported security hypothesis into an executable property and controlled counterexample. A broad fuzz campaign is not a substitute for a precise invariant, faithful state setup, or impact interpretation.

## Define the property and state model

State the conserved, monotonic, authorization, isolation, liveness, or transition property; relevant actors; reachable setup; bounded actions; external assumptions; and failure oracle. Read [references/invariant-harness-method.md](references/invariant-harness-method.md) before choosing handlers, ghost state, exclusions, or counterexample interpretation.

Keep protocol-wide risk in `assess-smart-contract-security`, source tracing in `audit-smart-contract-security`, and interactive Foundry/Anvil operation in `operate-evm-security-toolchain`. This skill owns the property and replayable harness evidence.

## Run the packaged offline harness when appropriate

Stage [scripts/run_smart_contract_invariant_harness.py](scripts/run_smart_contract_invariant_harness.py), its [manifest](scripts/manifest.json), and [assets/smart-contract-invariant-campaign.example.json](assets/smart-contract-invariant-campaign.example.json). The harness snapshots a bounded local tree through no-follow descriptors; invokes fixed `forge test --offline` with FFI disabled; denies child networking at the OS boundary; and retains bounded raw output with the snapshot digest and exact deterministic seed. It preserves only validated runtime-owned compiler-cache variables and refuses when the required compiler is absent offline.

The JSON campaign records attribution and bounds, never authority. Only use a source directory already placed in the engagement workarea under the active mission. Do not add dependency retrieval, forks, RPC endpoints, private keys, or model-selected executables.

## Interpret and deliver

Minimize a failing sequence without changing its reachable preconditions. Record seed, pattern, source digest, compiler and Foundry evidence, setup, action sequence, state delta, violated property, and whether the counterexample demonstrates security impact or only a harness/configuration defect.
