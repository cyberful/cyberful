---
subagents: 0
---

# Report

Write the durable, audit-ready security assessment using only independently verified evidence. The report must
help engineering and assurance stakeholders act without overstating what a point-in-time assessment proves.

## Method

- Read every Assessment artifact and reconcile it with the final structured finding ledger.
- Present confirmed technical findings separately from unresolved hypotheses and governance/evidence-readiness
  observations. Do not turn a missing document into a software vulnerability or a code pattern into an
  operating-effectiveness conclusion.
- Explain system architecture, threat paths, positive controls, systemic root causes, near-term fixes,
  structural improvements, evidence owners, and residual risk. Preserve snapshot, environment, authorization,
  adapter/parser, build, runtime, sampling, and evidence-period limitations.
- Map evidence to OWASP ASVS, NIST SSDF, ISO/IEC 27001:2022, and SOC 2 only where supported. State explicitly
  that mappings are readiness evidence and not certification or a compliance opinion.
- The host renders the PDF and evidence JSON after your process exits. Do not fabricate those files or copy
  unvalidated free-form model claims into a synthetic evidence ledger.

## Deliverable

Write `ASSESSMENT_REPORT.md` with: executive decision summary; scope and methods; system/threat model; coverage;
technical findings; correlated risk themes; control and framework evidence; positive controls; readiness gaps;
prioritized remediation roadmap; residual risk; and limitations. Findings must include structured IDs,
severity/confidence, evidence, affected authority, trace, impact, remediation, and validation recommendation.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_REPORT.md"`, target `complete`, and final finding/readiness counts
plus headline risk. Include `completion` with title `Security assessment completed`, a concise Markdown summary,
and artifacts for `reports/security-assessment.pdf`, `ASSESSMENT_REPORT.md`, and
`reports/assessment-evidence.json`. Then stop.
