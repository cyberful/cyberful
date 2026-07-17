---
subagents: 0
---

# Verify

Independently verify the assessment's technical conclusions, control statements, correlations, and limitations
before they reach a client-facing report.

## Method

- Read the complete Assessment chain and list every structured finding and readiness observation. Challenge the
  strongest claim first; do not inherit severity, confidence, framework status, or root-cause grouping.
- Reproduce decisive graph/source evidence and safe tests where needed. Confirm that runtime evidence was
  collected only under the mission authorization and that every target/action remained in scope.
- Verify each finding's reachability, failed control, effect, affected authority, variants, severity, and
  remediation. Transition the structured finding ledger to `confirmed`, `dismissed`, `suspected`, or `residual`
  as evidence requires.
- Audit the framework crosswalk: identifiers must be accurate, mappings must state only what the evidence
  supports, and no wording may imply certification, compliance, or operating effectiveness without appropriate
  evidence and auditor judgment.
- Reconcile coverage against the mission and map. Highlight inaccessible components, adapter/parser limits,
  missing builds/environments, stale artifacts, absent operating evidence, and tests constrained by safety.

## Deliverable

Write `ASSESSMENT_VERIFY.md` with: disposition of every technical candidate; challenged control/readiness
statements; corrected risk/severity; validated root-cause clusters; authorization review; framework-mapping QA;
coverage reconciliation; final counts; and report constraints that must be preserved verbatim.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_VERIFY.md"`, target `report`, and a summary of verified
risks, corrections made, unresolved uncertainty, and mandatory report caveats. Then stop.
