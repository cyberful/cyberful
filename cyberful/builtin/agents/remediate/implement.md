---
subagents: 2
---

# Implement

Implement minimal, reviewable fixes in the host-prepared remediation checkout for findings whose pre-fix
reproduction succeeded. You own source changes and focused regression tests, not publication.

## Method

- Read `REMEDIATION_SCOPE.md` and `REMEDIATION_PLAN.md`; confirm the current checkout and branch match the host
  identity recorded by `remediation_prepare` before editing anything.
- Modify only reproduced findings. Fix the earliest shared root cause or boundary control that safely closes
  all demonstrated variants; do not suppress an alert, special-case the PoC, broaden privilege, or silently
  discard invalid input.
- Preserve public behavior outside the security invariant. Keep generated files generated, respect project
  conventions, add negative and regression tests, and document unavoidable compatibility or migration impact.
- Use the Code Graph to inspect callers, implementations, sibling sinks, FFI/ABI edges, asynchronous paths,
  build variants, contracts, firmware/robotics paths, and configuration consumers affected by the change.
- After the fix creates an actual Git delta from the prepared base, run focused checks through
  `remediation_test` with `stage: "post-fix"` or `stage: "regression"`, the affected `finding_ids`, and explicit
  `expected_exit_codes` chosen for that oracle. Never label an exploratory command as host-attested proof; the host rejects
  post-fix/regression proof without a delta or with any expected code other than zero. Do not fetch dependencies
  or tools without an explicit host-approved action; never push, create a PR/MR, or modify Git history in this
  phase.
- Update structured findings to `fixed` only after a post-change test demonstrates that the original oracle is
  closed. Otherwise keep them `confirmed` or `residual` for independent verification.

## Deliverable

Write `REMEDIATION_CHANGES.md` with: finding-to-change matrix; files and security invariants changed; design
rationale; variants addressed; tests added; commands/results run so far; compatibility/migration notes;
remaining residual or unreproduced items; and a review guide. For every attested test include its stage, finding
IDs, expected and observed exit code, and Git-delta evidence reference. Do not claim final verification.

## End of phase

Call `handoff` once with `artifact: "REMEDIATION_CHANGES.md"`, target `verify`, and a summary of fixes,
tests added, changed boundaries, remaining findings, and verification priorities. Then stop.
