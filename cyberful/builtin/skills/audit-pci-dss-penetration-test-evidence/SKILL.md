---
name: audit-pci-dss-penetration-test-evidence
description: Audit PCI DSS penetration-test methodology, scope, internal and external reports, segmentation results, tester independence, remediation, retesting, retention, and multi-tenant support evidence. Use to identify unsupported Requirement 11.4 coverage without issuing a compliance verdict.
metadata:
  domain: payment-security
  subdomain: pci-penetration-evidence
  triggers:
    - audit pci dss penetration test evidence
    - review pci dss 11.4 report
    - pci penetration test evidence gap
    - validate pci retest documentation
    - review pci segmentation report
    - pci tester independence evidence
  tags:
    - pci-dss
    - requirement-11.4
    - evidence-review
    - penetration-test-report
    - remediation
    - retest
  frameworks:
    pci_dss:
      - 11.4.1
      - 11.4.2
      - 11.4.3
      - 11.4.4
      - 11.4.5
      - 11.4.6
      - 11.4.7
---

# Audit PCI DSS Penetration-Test Evidence

Audit whether the evidence set supports the entity's documented Requirement 11.4 claims. Review evidence identity, period, scope, provenance, applicability, and consistency; do not convert document presence into a PCI DSS compliance conclusion.

## Establish applicability

Read [references/evidence-evaluation-method.md](references/evidence-evaluation-method.md). Confirm PCI DSS version, entity type, whether segmentation reduces scope, assessment period, significant changes, validation process, and the evidence owner. Requirements 11.4.6 and 11.4.7 have service-provider applicability that must not be inferred from a report title.

## Reconcile the evidence chain

Compare the defined methodology, current CDE trace, scope of work, internal and external reports, test dates, change-triggered tests, tester qualifications and independence, segmentation coverage, finding risk treatment, remediation records, repeated tests, retention, and customer-support evidence where applicable.

For every claim, preserve the exact evidence reference and the element it supports. Distinguish absent evidence, stale evidence, inconsistent scope, unresolved applicability, unsupported sampling, missing remediation, and missing retest. Do not accept a clean executive summary as proof that the required attack surfaces and methods were exercised.

## Normalize bounded evidence metadata

Use [scripts/audit_pci_penetration_evidence.py](scripts/audit_pci_penetration_evidence.py) only on a staged metadata ledger that contains no PAN, SAD, credentials, report bodies, or other payment secrets. Start from [assets/pci-penetration-evidence.example.json](assets/pci-penetration-evidence.example.json) and retain [assets/pci-penetration-evidence.schema.json](assets/pci-penetration-evidence.schema.json).

The offline analyzer groups exact evidence references, derives the requirement set implied by entity type and segmentation use, and reports unobserved requirements, requirements without supported evidence metadata, same-topic status conflicts, and applicability warnings. Its output follows [assets/pci-penetration-evidence-audit.schema.json](assets/pci-penetration-evidence-audit.schema.json). It does not read referenced evidence, judge tester competence, validate a technical finding, or decide compliance.

## Conclude at the evidence boundary

Report what is supported, what is missing, what conflicts, what is blocked, and the shortest next discriminator. Route scope contradictions to `trace-cardholder-data-environment`, methodology gaps to `plan-pci-dss-penetration-test`, and isolation claims to `test-cardholder-data-segmentation`.

Do not create an AOC, ROC, SAQ response, QSA opinion, or certification statement. Formal applicability and compliance decisions remain with the entity, its assessor where applicable, and the compliance-accepting entity.

## Authoritative anchors

- PCI DSS v4.0.1: https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf
- PCI SSC Penetration Testing Guidance v1.1: https://www.pcisecuritystandards.org/documents/Penetration-Testing-Guidance-v1_1.pdf
