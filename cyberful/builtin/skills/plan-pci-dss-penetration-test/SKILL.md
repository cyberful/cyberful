---
name: plan-pci-dss-penetration-test
description: Plan an authorized PCI DSS penetration test around the cardholder data environment, critical systems, internal and external coverage, segmentation, tester independence, remediation, retesting, and evidence retention. Use when defining a PCI DSS 11.4 methodology or engagement.
metadata:
  domain: payment-security
  subdomain: pci-penetration-planning
  triggers:
    - pci dss penetration test plan
    - pci dss 11.4 methodology
    - cardholder environment pen test planning
    - internal external pci penetration testing
    - pci test rules of engagement
    - pci significant change testing
  tags:
    - pci-dss
    - requirement-11.4
    - cde
    - penetration-testing
    - rules-of-engagement
    - retest
  frameworks:
    pci_dss:
      - 11.4.1
      - 11.4.2
      - 11.4.3
      - 11.4.4
---

# Plan a PCI DSS Penetration Test

Build a test plan that is authorized, representative of the real cardholder data environment, and traceable to the entity's defined methodology. Do not treat a vulnerability scan, an ASV scan, or a generic application test as a substitute for penetration testing.

## Establish the planning basis

Read [references/pci-penetration-methodology.md](references/pci-penetration-methodology.md). Treat PCI DSS v4.0.1 as normative. Use the PCI SSC Penetration Testing Guidance v1.1 only as supplemental methodology: it predates v4.0.1 and references the former Requirement 11.3.

Confirm the entity type, assessment period, authorization owner, tester independence, CDE owner, significant changes, previous threats and vulnerabilities, and evidence-handling restrictions. A plan records authority; it does not create it.

## Resolve scope before coverage

Use `trace-cardholder-data-environment` when CDE boundaries, account-data flows, connected-to systems, critical systems, third-party paths, administrative access, or scope-reduction claims are uncertain. Do not silently accept a supplied asset list as the complete CDE.

Define internal and external vantage points and both application-layer and network-layer coverage. Relate every target and test family to a CDE boundary, critical system, data flow, scope-reduction control, significant change, or threat observed during the previous 12 months.

Use `test-cardholder-data-segmentation` when segmentation reduces scope. Cover every segmentation method in use and record why any representative sampling is sufficient.

## Produce the engagement contract

Complete [assets/pci-penetration-test-plan.template.json](assets/pci-penetration-test-plan.template.json) under [assets/pci-penetration-test-plan.schema.json](assets/pci-penetration-test-plan.schema.json). Include rules of engagement, stop conditions, communication and incident paths, handling of encountered account data, tester-origin details, test windows, request or effect limits, cleanup, success criteria, evidence retention, remediation ownership, and retest criteria.

Route specialist execution to the narrowest Cyberful skills. Preserve the plan as the coverage ledger that ties their evidence together; do not duplicate their procedures here.

## Close planning gaps explicitly

Do not label an unknown boundary, unavailable environment, absent test account, or unapproved effect as covered. Record the exact dependency and owner. After execution, use `audit-pci-dss-penetration-test-evidence` to reconcile the plan, results, remediation, and retests without issuing an automated compliance verdict.

## Authoritative anchors

- PCI DSS v4.0.1: https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf
- PCI SSC Penetration Testing Guidance v1.1: https://www.pcisecuritystandards.org/documents/Penetration-Testing-Guidance-v1_1.pdf
