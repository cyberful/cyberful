---
name: audit-application-code
description: Coordinate a repository-wide white-box application security audit across architecture, source, configuration, dependencies, build, and deployment paths. Use when multiple specialist reviews must share scope, trust boundaries, coverage, and evidence; use a narrower audit or trace skill for a single mechanism.
metadata:
  domain: code-audit
  subdomain: application-security-routing
  triggers:
    - repository security audit
    - secure code review
    - white box assessment
    - application code audit
    - source security review
    - security architecture implementation
  tags:
    - OWASP-ASVS
    - CWE
    - NIST-SSDF
    - trust-boundaries
    - code-audit
  frameworks:
    nist_csf:
      - ID.RA
      - PR.PS
---

# Audit Application Code

Coordinate the audit; do not reproduce every specialist procedure in this skill.

## Establish the shared audit contract

Record repository and commit, components, environments, languages, build/deployment paths, generated-code policy, exclusions, assurance objective, available tests, and inaccessible evidence. Read [references/repository-mapping.md](references/repository-mapping.md) to produce a component, entry-point, trust-boundary, identity, persistence, dependency, and privileged-operation map.

Create one coverage ledger:

`component | entry point | security objective | specialist | evidence | result | limitation | next action`

## Route the review

- Authorization and policy placement: `audit-access-policy-enforcement` and `test-authorization-boundaries`.
- API contract drift and binding: `audit-api-contract-implementation` and `analyze-api-contract-coverage`.
- Persistence authority: `audit-database-access-layer`.
- Logs and detection evidence: `audit-security-logging-telemetry`.
- Attacker-controlled interpreter paths: `trace-injection-dataflows`.
- Producer-to-runtime trust: `audit-software-supply-chain`.
- Release change risk: `analyze-release-security-diff`.
- Cloud, AI, mobile, native, firmware, desktop, and smart-contract components: the matching `audit-`, `assess-`, or `trace-` specialist.

Use [references/language-patterns.md](references/language-patterns.md) only to select relevant specialists and search anchors for languages actually in scope.

## Integrate evidence

Require each specialist to identify the reachable path, enforcement owner, expected negative case, observed effect, evidence location, and residual uncertainty. Apply the shared classifications in [references/evidence-model.md](references/evidence-model.md); scanner output and suspicious syntax remain leads until a complete path or control failure is supported.

Deduplicate by violated invariant and enforcement owner, not by file or endpoint. Reconcile uncovered components, alternative channels, background processing, deployment-only controls, and unavailable builds before closing the ledger. Deliver scope, architecture, coverage, confirmed findings, context-dependent leads, controls observed, systemic causes, remediation ownership, regression evidence, and limitations.
