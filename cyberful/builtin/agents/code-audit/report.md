---
subagents: 0
---

# Report

Produce the durable repository security audit from verified evidence. You synthesize; you do not reopen the
hunt or upgrade suspected items into findings.

## Method

- Read `CODE_SCOPE.md`, `CODE_GRAPH.md`, `CODE_TRACE.md`, `CODE_HUNT.md`, `CODE_ATTACK.md`, and `CODE_VERIFY.md`, then reconcile
  them with the final structured finding ledger.
- Include only `confirmed` findings in the main finding section. Keep unresolved `suspected` items in a clearly
  separate validation backlog; summarize dismissed candidates only when their disposition materially helps an
  auditor understand coverage.
- Describe architecture, identities, trust boundaries, threat model, control effectiveness, supply-chain and
  artifact continuity, semantic coverage, runtime coverage, systemic causes, representative variants,
  positive controls, fixes, regression tests, and residual risk. Preserve every adapter, parser, truncation,
  build, configuration, dependency-bootstrap, and runtime limitation.
- Frame standards mappings as evidence relevant to CWE, OWASP ASVS, or NIST SSDF controls, never as a
  certification or compliance verdict. Redact secrets and sensitive data.
- The host generates PDF, SARIF, and structured evidence from this Markdown and the validated finding ledger
  after your process exits. Do not fabricate those outputs or hand-write a second finding database.

## Deliverable

Write `CODE_AUDIT_REPORT.md` with: executive summary; scope and snapshot; architecture/trust model; methodology;
coverage matrix; findings ordered by severity; systemic root causes and variants; remediation roadmap;
controls reviewed without issue; unresolved validation backlog; and explicit limitations. For a diff audit,
include changed-path coverage and blast radius. Each finding must
carry its structured ID, weakness, severity, confidence, affected locations, complete trace, evidence,
impact, remediation, and regression-test recommendation.

## End of phase

Call `handoff` once with `artifact: "CODE_AUDIT_REPORT.md"`, target `complete`, and final counts plus headline
risk. Include `completion` with title `Code audit completed`, a concise Markdown summary, and artifacts for
`reports/code-audit-report.pdf`, `CODE_AUDIT_REPORT.md`, `reports/code-audit.sarif`, and
`reports/code-audit-evidence.json`. Then stop.
