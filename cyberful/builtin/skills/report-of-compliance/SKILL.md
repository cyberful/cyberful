---
name: report-of-compliance
description: Assemble reviewed compliance evidence into a versioned, traceable draft report for PCI DSS or GDPR. Use when a reporting phase needs a requirement matrix, gaps, limitations, provenance, and qualification boundaries; never treat the draft as a certification or legal conclusion.
metadata:
  domain: governance-risk-compliance
  subdomain: compliance-reporting
  triggers:
    - report on compliance
    - compliance evidence report
    - PCI DSS ROC draft
    - GDPR accountability report
    - requirement evidence matrix
    - compliance reporting package
  tags:
    - compliance-reporting
    - evidence-traceability
    - pci-dss
    - gdpr
    - accountability
    - attestation-boundary
  frameworks:
    pci_dss:
      - "11.4.1"
      - "12.5.2"
    gdpr:
      - "Article 5(2)"
      - "Article 24"
      - "Article 30"
      - "Article 32"
      - "Article 35"
---

# Report of Compliance

Build a reviewable draft from evidence that already exists. This skill organizes provenance and reporting status; it does not perform missing tests, decide legal applicability, qualify an assessor, issue an attestation, or turn an unsupported statement into evidence.

## Select one profile

- For PCI DSS, read [references/pci-dss-4.0.1.md](references/pci-dss-4.0.1.md) and use [assets/profiles/pci-dss-4.0.1.json](assets/profiles/pci-dss-4.0.1.json). The result is an evidence package for the official PCI SSC Report on Compliance workflow, not an official ROC or AOC.
- For GDPR, read [references/gdpr-accountability.md](references/gdpr-accountability.md) and use [assets/profiles/gdpr-eu-2016-679.json](assets/profiles/gdpr-eu-2016-679.json). The result is an accountability and compliance-evidence report, because GDPR defines no universal ROC form.
- When the requested framework, jurisdiction, entity role, version, or deliverable is unclear, read [references/framework-selection.md](references/framework-selection.md) before compiling.
- Before describing a result as final, approved, attested, or compliant, read [references/qualification-and-attestation.md](references/qualification-and-attestation.md).

Do not load both framework references unless the requested report deliberately covers both frameworks.

## Required input

Establish the report identifier, entity and role, framework profile, assessment period, evidence cutoff, scope statement, assessor identity and qualification as declared facts. For each profile need, record one bounded status, rationale, evidence references, finding references, owner, and optional remediation date. References should point to sealed workarea artifacts or stable external records; do not copy cardholder data, sensitive authentication data, personal data, credentials, or full work papers into the input.

Use `supported` only for an evidence-backed statement. Use `not-applicable-with-rationale` only when a reviewer has supplied the applicability rationale. Preserve `partially-supported`, `unsupported`, `not-tested`, and `conflicting-evidence` honestly; the renderer must not collapse them into a positive conclusion.

## Compile the draft

1. Read this file completely and the one selected framework reference.
2. Stage `scripts/build_compliance_report.py`, `assets/compliance-report-input.schema.json`, the selected profile, and [assets/templates/compliance-report.md](assets/templates/compliance-report.md).
3. Prepare an input matching [assets/compliance-report-input.schema.json](assets/compliance-report-input.schema.json). Keep the profile identifier identical to the staged profile.
4. Run the staged script offline with `--workspace`, `--input`, `--profile`, and a new `--output` path. The script validates need identifiers, expands unobserved needs as `not-tested`, preserves evidence references, and emits deterministic JSON with a bounded Markdown draft.
5. Review every gap, conflict, applicability rationale, limitation, and qualification claim against the referenced source artifacts. Route missing technical evidence to the appropriate plan, trace, test, audit, or analyze skill instead of inventing prose.
6. Use the Markdown draft as a working deliverable. For PCI DSS, transfer reviewed content only into the current official template supplied through the engagement; for GDPR, adapt the report title and jurisdictional sections without representing it as an authority-issued form.

## Completion boundary

Complete when every profile need is represented, source/profile digests and evidence references are retained, limitations and unresolved needs are visible, and the artifact is explicitly labeled `draft`. Approval, signature, QSA/ISA work, DPO or counsel review, supervisory-authority acceptance, and formal compliance status remain outside this skill.
