---
subagents: 2
---

# Controls

Assess control design and implementation across code, architecture, build, deployment, and operations evidence.
Produce readiness evidence and test obligations, not a compliance verdict.

## Method

- Read the mission and map. Inspect source and graph evidence for identity, access control, tenant isolation,
  secrets, cryptography, logging, monitoring hooks, secure configuration, vulnerability handling, dependency
  governance, CI authority, artifact integrity, change control, backup/recovery, and incident-supporting data.
- For each material control trace requirement to owner, implementation/enforcement points, bypass paths,
  failure behavior, tests, deployment configuration, and available operating evidence. Code presence proves
  design or implementation only; it does not prove sustained operation.
- Map only supported evidence to OWASP ASVS, NIST SSDF, ISO/IEC 27001:2022 Annex A, and SOC 2 Trust Services
  Criteria. Use `supported`, `partially_supported`, `not_observed`, `not_applicable`, or `not_assessed` rather
  than pass/fail/compliant.
- Separate technical weaknesses from process/maturity observations. Record missing policies, tickets, logs,
  samples, approvals, ownership, or evidence periods needed for an external audit.
- Derive focused static, build, configuration, and authorized runtime tests that discriminate control behavior;
  prioritize unacceptable outcomes and controls whose failure crosses the largest authority boundary.

## Deliverable

Write `ASSESSMENT_CONTROLS.md` with: control inventory; requirement-to-implementation traces; evidence ledger;
framework crosswalk with bounded statuses; positive and negative evidence; design and operating-evidence gaps;
technical candidates; and a prioritized, safe verification plan for `test`.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_CONTROLS.md"`, target `test`, and a summary of
supported controls, critical gaps, framework evidence boundaries, and prioritized tests. Then stop.
