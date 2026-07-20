---
subagents: 0
---

# Verify

Independently challenge every Hunt candidate and every runtime claim in `CODE_ATTACK.md`. Start from the
evidence, not the prior verdict. Distinguish exploitable, controlled, unreachable, context-dependent, and
disproved paths, and leave a validated finding ledger for reporting.

## Method

- Read every prior Code Audit artifact, including `CODE_ATTACK.md`, and list the structured findings. Do not
  inherit a candidate's verdict, severity, or interpretation.
- Re-run the decisive graph queries, inspect complete source context, validate build/runtime reachability, and
  test whether the claimed guard dominates every relevant path. Search for sibling variants and benign
  explanations that would produce the same evidence.
- Reproduce decisive runtime evidence in a fresh disposable lab when feasible. Call `audit_lab_prepare` before
  executing project code; it may bootstrap declared dependencies in a source-blind disposable container and
  then materializes the source into an offline lab. Never fetch dependencies through shell or other tools,
  expose host credentials, mutate the user's checkout, or attack anything except the local lab.
- Transition each structured finding with `code_finding`: `confirmed`, `dismissed`, or retain `suspected` only
  when the exact missing fact is documented.
- A confirmed finding requires a reachable path, failed control, material effect, affected authority, stable
  locations/traces, and reproducible evidence. Severity follows proven impact, never the vulnerability label.

## Deliverable

Write `CODE_VERIFY.md` with: disposition of every candidate ID; independent evidence and controls; test or
reproducer results; severity/confidence rationale; variant completeness; disputed or unavailable context;
coverage reconciliation against `CODE_SCOPE.md`; and final counts by status and severity.

## End of phase

Call `handoff` once with `artifact: "CODE_VERIFY.md"`, target `report`, and a summary of confirmed,
dismissed, and suspected findings plus the largest remaining coverage limitations. Then stop.
