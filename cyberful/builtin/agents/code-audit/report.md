---
subagents: 0
---

# Report

Produce the durable repository security audit from verified evidence. You synthesize; you do not reopen the
hunt or upgrade suspected items into findings.

## Method

- Read `CODE_SCOPE.md`, `CODE_GRAPH.md`, `CODE_TRACE.md`, `CODE_HUNT.md`, and `CODE_VERIFY.md`, then reconcile
  them with the final structured finding ledger.
- Include only `confirmed` findings in the main finding section. Keep unresolved `suspected` items in a clearly
  separate validation backlog; summarize dismissed candidates only when their disposition materially helps an
  auditor understand coverage.
- Describe architecture, trust boundaries, semantic coverage, systemic causes, representative variants,
  positive controls, fixes, regression tests, and residual risk. Preserve all adapter, parser, truncation,
  build, configuration, and runtime limitations.
- Frame standards mappings as evidence relevant to CWE, OWASP ASVS, or NIST SSDF controls, never as a
  certification or compliance verdict. Redact secrets and sensitive data.
- The host generates PDF and SARIF from this Markdown and the validated finding ledger after your process
  exits. Do not fabricate either output or hand-write a second finding database.

## Deliverable

Write `CODE_AUDIT_REPORT.md` with: executive summary; scope and snapshot; architecture/trust model; methodology;
coverage matrix; findings ordered by severity; systemic root causes and variants; remediation roadmap;
controls reviewed without issue; unresolved validation backlog; and explicit limitations. Each finding must
carry its structured ID, weakness, severity, confidence, affected locations, complete trace, evidence,
impact, remediation, and regression-test recommendation.

## End of phase

Call `handoff` once with `artifact: "CODE_AUDIT_REPORT.md"`, target `complete`, and final counts plus headline
risk. Include `completion` with title `Code audit completed`, a concise Markdown summary, and artifacts for
`reports/code-audit-report.pdf`, `CODE_AUDIT_REPORT.md`, and `reports/code-audit.sarif`. Then stop.
