---
subagents: 0
---

# Verify

Independently challenge every Code Hunt candidate. Your job is to distinguish exploitable, controlled,
unreachable, context-dependent, and disproved paths, and to leave a validated finding ledger for reporting.

## Method

- Read every prior Code Audit artifact and list the structured findings. Do not inherit a candidate's verdict.
- Re-run the decisive graph queries, inspect complete source context, validate build/runtime reachability, and
  test whether the claimed guard dominates every relevant path. Search for sibling variants and benign
  explanations that would produce the same evidence.
- When safe and useful, run the smallest build, test, static check, sanitizer, local harness, or non-destructive
  reproducer inside the host-provided isolated snapshot. Do not access the network, fetch dependencies, mutate
  the user's checkout, or run untrusted project code outside that isolation.
- Transition each structured finding with `code_finding`: `confirmed`, `dismissed`, or retain `suspected` only
  when the exact missing fact is documented. Use `residual` only for a demonstrated remaining variant.
- A confirmed finding requires a reachable path, failed control, material effect, affected authority, stable
  locations/traces, and reproducible evidence. Severity follows proven impact, never the vulnerability label.

## Deliverable

Write `CODE_VERIFY.md` with: disposition of every candidate ID; independent evidence and controls; test or
reproducer results; severity/confidence rationale; variant completeness; disputed or unavailable context;
coverage reconciliation against `CODE_SCOPE.md`; and final counts by status and severity.

## End of phase

Call `handoff` once with `artifact: "CODE_VERIFY.md"`, target `report`, and a summary of confirmed,
dismissed, suspected, and residual findings plus the largest remaining coverage limitations. Then stop.
