---
name: trace-cardholder-data-environment
description: Reconstruct the cardholder data environment from payment flows, account-data locations, connected-to and security-impacting systems, critical services, third parties, administrative paths, and segmentation claims. Use when PCI DSS scope or penetration-test coverage is uncertain.
metadata:
  domain: payment-security
  subdomain: cardholder-data-environment
  triggers:
    - trace cardholder data environment
    - map cde scope
    - cardholder data flow analysis
    - pci dss scope reconstruction
    - identify systems impacting cde
    - payment data boundary trace
  tags:
    - pci-dss
    - cde
    - cardholder-data
    - data-flow
    - scoping
    - third-party
  frameworks:
    pci_dss:
      - 11.4.1
      - 12.5.2
      - 12.5.2.1
---

# Trace the Cardholder Data Environment

Reconstruct scope from evidence rather than inheriting an inventory label. The CDE includes people, processes, and technology that store, process, or transmit cardholder data or sensitive authentication data. PCI DSS scope also includes system components connected to the CDE or capable of impacting its security.

## Build the boundary graph

Read [references/cde-scoping-method.md](references/cde-scoping-method.md). Start from payment stages and acceptance channels. Trace authorization, capture, settlement, chargebacks, refunds, customer support, administration, backups, recovery, observability, security services, batch flows, exports, and disposal.

For each hop, record the data class, transformation, principal, protocol, trust boundary, storage, retention, encryption or tokenization claim, owner, third party, and evidence. Never record a PAN, SAD value, authentication factor, cryptographic key, or payment secret in the ledger. Use synthetic identifiers and evidence references.

## Classify systems by causal reach

Separate:

- systems that store, process, or transmit account data;
- systems directly connected to those systems;
- authentication, administration, deployment, logging, backup, recovery, name-resolution, network-control, and security services that could affect CDE security;
- third-party and remote-access paths;
- systems claimed out of scope through segmentation;
- unresolved components whose reach or data handling is not yet supported.

Do not infer that encryption, tokenization, outsourcing, or a vendor attestation automatically removes a component from scope. Record the exact scoping rationale and evidence owner.

## Produce the trace artifact

Populate [assets/cde-boundary-ledger.template.json](assets/cde-boundary-ledger.template.json) under [assets/cde-boundary-ledger.schema.json](assets/cde-boundary-ledger.schema.json). Every node and flow needs stable evidence references. Every exclusion needs a documented isolation mechanism and the environment from which isolation is claimed.

Route uncertain isolation claims to `test-cardholder-data-segmentation`. Route the resulting scope and critical-system inventory to `plan-pci-dss-penetration-test` for coverage design.

## Report uncertainty without shrinking scope

An unobserved flow, unavailable third-party diagram, unknown backup, or unverified control is a scope gap, not proof that a component is out of scope. Preserve conflicting evidence and the shortest next discriminator. Never issue a PCI DSS compliance conclusion from this trace alone.

## Authoritative anchors

- PCI DSS v4.0.1: https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf
- PCI SSC PCI DSS overview: https://www.pcisecuritystandards.org/standards/pci-dss/
