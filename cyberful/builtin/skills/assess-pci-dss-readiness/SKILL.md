---
name: assess-pci-dss-readiness
description: Coordinate a PCI DSS penetration-testing and CDE-scoping readiness assessment across methodology, scope, segmentation, execution evidence, remediation, and retesting. Use for Requirement 11.4 readiness; do not use it as a full PCI DSS compliance assessment or attestation.
metadata:
  domain: payment-security
  subdomain: pci-dss-readiness
  triggers:
    - assess pci dss readiness
    - pci dss penetration testing readiness
    - pci dss 11.4 gap assessment
    - cde scope readiness review
    - pci segmentation evidence readiness
    - payment security assessment preparation
  tags:
    - pci-dss
    - readiness
    - requirement-11.4
    - cde
    - gap-assessment
    - evidence
  frameworks:
    pci_dss:
      - 11.4.1
      - 12.5.2
---

# Assess PCI DSS Readiness

Coordinate readiness for PCI DSS CDE scoping and penetration-testing obligations. This package is a router and integration layer for Requirements 11.4 and 12.5.2; it is not a complete assessment of all PCI DSS requirements, a Report on Compliance, a Self-Assessment Questionnaire, an Attestation of Compliance, or a certification decision.

## Establish the assessment boundary

Read [references/readiness-routing.md](references/readiness-routing.md). Confirm the PCI DSS version, entity type, selected validation process, assessor or compliance-accepting entity, assessment period, services, third parties, and whether segmentation reduces scope. If the request requires a full PCI DSS assessment, retain the broader requirement inventory as an external dependency and restrict this skill to its supported scope.

## Route to specialist evidence

- Use `trace-cardholder-data-environment` to reconstruct payment flows, CDE components, connected and security-impacting systems, third-party paths, critical systems, and scope gaps.
- Use `plan-pci-dss-penetration-test` to define the methodology, internal and external coverage, application and network layers, tester qualifications and independence, significant-change triggers, rules of engagement, retention, remediation, and retest criteria.
- Use `test-cardholder-data-segmentation` when any segmentation or isolation control supports a scope-reduction claim.
- Use `audit-pci-dss-penetration-test-evidence` to normalize the resulting evidence and identify unsupported or missing requirements without deciding compliance.

Do not repeat specialist procedures in the readiness layer. Preserve their artifact identities and reconcile conflicts, applicability, ownership, and dates.

## Maintain the readiness register

Populate [assets/pci-readiness-register.template.json](assets/pci-readiness-register.template.json) under [assets/pci-readiness-register.schema.json](assets/pci-readiness-register.schema.json). Record each applicable requirement, evidence, status, owner, next action, and dependency. Use `not-applicable` only with an entity- and environment-specific rationale; a missing artifact is a gap, not non-applicability.

Separate:

- readiness of the entity's methodology and evidence;
- technical results from authorized testing;
- assessor validation and formal reporting;
- residual work outside Requirements 11.4 and 12.5.2.

Conclude with supported readiness, open gaps, blocked evidence, and the exact next discriminator. Never state that the entity is PCI DSS compliant.

## Authoritative anchors

- PCI DSS v4.0.1: https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf
- PCI SSC PCI DSS overview: https://www.pcisecuritystandards.org/standards/pci-dss/
