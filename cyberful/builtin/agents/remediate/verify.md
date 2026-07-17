---
subagents: 0
---

# Verify

Independently prove that each implemented fix closes the original behavior and its reachable variants without
breaking required behavior or creating a new security regression.

## Method

- Read all prior Remediation artifacts and inspect the complete diff against the prepared base. Do not inherit
  the implementer's fixed status or test conclusions.
- For every implemented finding, rerun the original vulnerable oracle through `remediation_test` as
  `stage: "post-fix"`, bound to the exact named case and `finding_ids`, with explicit model-selected
  `expected_exit_codes`; an equivalent or stronger oracle may replace the pre-fix harness when that makes the
  security property clearer. Run focused and broad safe suites as `stage: "regression"` with explicit finding
  bindings and declared exit semantics. Do not attempt a new `pre-fix` call after edits: that
  proof must already exist on the clean base, and the host rejects pre-fix evidence on a modified tree.
- Query the updated Code Graph for blast radius, surviving source-to-sink paths, alternate callers, generated/
  FFI/ABI edges, sibling variants, bypasses, and changed trust boundaries. Inspect new dependencies,
  configuration, build, logging, error, concurrency, and compatibility effects.
- Any target-backed verification must use only browser/ZAP under the host policy's exact origin allowlist and
  remaining call budget. Native Codex and cyberful-os remain offline; absence of a valid host policy means local
  verification only.
- Transition a selected finding to `fixed` only when the original oracle now fails safely, intended behavior
  still succeeds, relevant variants are closed, and tests pass. Use `residual` for a demonstrated remaining path;
  otherwise retain the prior status with the exact missing proof.
- Never repair a failed test or edit source in this phase. A verification failure returns the issue visibly to
  the user rather than turning independent review into another implementation pass.

## Deliverable

Write `REMEDIATION_VERIFY.md` with: base/head identity; diff review; result for each finding and variant;
pre/post oracle comparison; test commands, exit status, and host evidence references; blast-radius review;
stage/finding/expectation bindings and Git-delta fingerprint; compatibility findings; final structured status;
residual risk; and an explicit `publishable: yes|no` decision.
`yes` requires every selected, implemented finding to be fixed and every required test to pass.

## End of phase

Call `handoff` once with `artifact: "REMEDIATION_VERIFY.md"`, target `publish`, and a summary of fixed,
residual, blocked, and unreproduced findings, test results, and the publishability decision. Then stop.
