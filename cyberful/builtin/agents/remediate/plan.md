---
subagents: 0
---

# Plan

Prepare the host-managed remediation checkout and prove every selected vulnerability before authorizing source
changes. A plausible code path or old report is not a reproduction.

## Method

- Read `REMEDIATION_SCOPE.md`. Load `operate-code-graph`, `audit-application-code`, and the narrowest applicable
  vulnerability skills.
- Use `remediation_prepare` to create the isolated remediation checkout and its
  `cyberful/remediate/<slug>-<session>` branch. Never edit the user's original checkout, include its dirty changes,
  switch its branch, fetch a ref, or construct an alternate worktree manually.
- Re-run graph/source evidence against the prepared base. Before any source edit, execute each declared pre-fix
  test through `remediation_test` with `stage: "pre-fix"`, the exact `finding_ids`, and the model-selected
  `expected_exit_codes` that demonstrate the vulnerable condition. The host requires the clean prepared base but
  does not impose a zero/non-zero convention on the oracle.
  Preserve the vulnerable result and benign control. Use target traffic only through browser/ZAP when a valid
  host runtime policy exists, and stay inside its exact origins and remaining call budget as well as the scope
  rules. Native Codex and cyberful-os remain offline; never replace a denied route with a shell network client.
- Findings that fail reproduction remain unverified and receive no code change. Record the exact observed result
  and the missing evidence; do not modify code in hope that the report was right.
- For reproduced findings, design the smallest root-cause fix, enumerate variants and compatibility constraints,
  name files expected to change, and define regression/negative tests. Avoid dependency upgrades or public API
  changes unless they are necessary to close the demonstrated issue.

## Deliverable

Write `REMEDIATION_PLAN.md` with: isolated checkout/branch identity; clean base proof; pre-fix result and control
for every selected ID, including stage, finding IDs, expected and observed exit code; reproduced and unreproduced
sets; root-cause/variant analysis; minimal patch plan;
compatibility and migration effects; regression tests; rollback strategy; and explicit implementation order.

## End of phase

Call `handoff` once with `artifact: "REMEDIATION_PLAN.md"`, target `implement`, and a summary of the
prepared branch, reproduced findings allowed to change, blocked items, planned files, and test gates. Then stop.
