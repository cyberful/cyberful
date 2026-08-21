---
name: audit-smart-contract-security
description: Audit smart-contract source and build evidence for authorization, accounting, state-machine, external-call, upgrade, signature, oracle, token-integration, and denial-of-service defects. Use for code-level Solidity or EVM review with explicit deployed and architectural assumptions.
metadata:
  domain: application-security
  subdomain: smart-contract-code-audit
  triggers:
    - audit smart contract security
    - Solidity code audit
    - EVM contract code review
    - audit DeFi accounting logic
    - review proxy upgrade security
  tags:
    - Solidity
    - EVM
    - code-audit
    - state-machine
    - accounting
    - upgradeability
  frameworks:
    nist_csf:
      - PR.PS
      - ID.RA
---

# Audit Smart Contract Security

Audit executable state transitions and their assumptions. Do not infer deployed configuration, proxy targets, initialization, or external dependency behavior from source layout alone.

## Reconstruct reachable state transitions

Inventory external entry points, modifiers, roles, delegate calls, callbacks, token hooks, signatures, upgrade routes, initialization, storage layout, factories, libraries, and cross-contract calls. Trace value, shares, debt, collateral, fees, voting power, nonces, timestamps, prices, and units through each security-critical transition.

Copy [assets/contract-invariant-ledger.template.json](assets/contract-invariant-ledger.template.json) into the workarea. Read [references/contract-audit-method.md](references/contract-audit-method.md) before classifying an accounting, upgrade, or composability finding.

## Challenge implementation invariants

Review authorization at the final state-changing boundary; checks-effects-interactions and reentrant state; rounding and conservation; zero, maximum, stale, and partial states; signature domain and replay; proxy and initializer safety; storage collisions; oracle freshness and manipulation; token deviations; denial of service; and recovery behavior.

Route executable properties to `test-smart-contract-invariants`, broad protocol and deployment risk to `assess-smart-contract-security`, and tool operation to `operate-evm-security-toolchain`. Keep this skill centered on code evidence and variants.

## Deliver

For each candidate, identify the violated invariant, reachable path, attacker-controlled inputs or state, required deployment assumptions, affected asset, control comparison, source locations, and smallest reproducible validation. Downgrade findings whose deployment or economic prerequisites remain unsupported.
