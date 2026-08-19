---
name: assess-smart-contract-security
description: Assess the security of a smart-contract system across protocol economics, trust roles, upgrade and governance paths, oracle and bridge dependencies, deployment state, and off-chain operators. Use for broad EVM or cross-chain risk reviews before routing code, invariant, or toolchain work.
metadata:
  domain: application-security
  subdomain: smart-contract-assessment
  triggers:
    - assess smart contract security
    - protocol security review
    - DeFi threat assessment
    - smart contract architecture risk
    - bridge and oracle risk assessment
  tags:
    - smart-contracts
    - EVM
    - DeFi
    - protocol-economics
    - governance
    - cross-chain
  frameworks:
    nist_csf:
      - ID.RA
      - GV.RM
---

# Assess Smart Contract Security

Assess the implemented protocol as a socio-technical system. Contract source alone cannot establish the deployed bytecode, active configuration, privileged operators, economic dependencies, or cross-chain state that determine real exposure.

## Establish the system and unacceptable outcomes

Inventory contracts, proxies, factories, libraries, tokens, roles, multisigs, timelocks, keepers, relayers, oracles, bridges, frontends, indexers, deployment networks, and upgrade history. Define unacceptable outcomes in asset and state terms: unauthorized value transfer, insolvency, frozen funds, unbacked issuance, governance capture, replay, censorship, or unrecoverable liveness loss.

Copy [assets/protocol-risk-ledger.template.json](assets/protocol-risk-ledger.template.json) into the workarea. Read [references/protocol-risk-method.md](references/protocol-risk-method.md) before rating economic or cross-system risk.

## Reconcile claims with deployed evidence

Trace each critical outcome to authority, callable transitions, external state, timing, pricing, liquidity, and failure assumptions. Compare documentation, source, build artifacts, deployment bytecode, initialization, live roles, and operational procedures without treating any one source as canonical.

Route source-level review to `audit-smart-contract-security`, executable properties to `test-smart-contract-invariants`, and Foundry or Anvil operation to `operate-evm-security-toolchain`. Do not duplicate those procedures here.

## Deliver

Produce a bounded risk ledger with evidence, affected assets, prerequisites, exploitability conditions, blast radius, existing controls, uncertainty, owner, treatment, and validation route. Separate a plausible mechanism from a deployable attack and from demonstrated impact.
