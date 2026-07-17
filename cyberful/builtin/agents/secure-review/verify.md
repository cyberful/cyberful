---
subagents: 0
---

# Verify

Independently verify candidate regressions and produce the final incremental security review. Do not fix code,
publish forge feedback, or convert unrelated pre-existing issues into review blockers.

## Method

- Read `REVIEW_MAP.md` and `REVIEW_FINDINGS.md`; validate that the local comparison and working-tree snapshot have
  not changed. If they changed, record the review as stale rather than mixing snapshots.
- Re-run decisive source/graph queries and the smallest safe local test for each candidate. Compare base and
  reviewed behavior, challenge benign explanations, verify guard dominance and variants, and inspect complete
  surrounding code rather than accepting a diff hunk alone.
- Confirm a finding only when the reviewed change causally introduces, aggravates, or makes reachable a material
  security failure. Transition structured candidates to `confirmed`, `dismissed`, or `suspected`; preserve the
  exact missing proof for unresolved items.
- Assign severity from demonstrated attacker capability and affected authority. Provide a minimal remediation
  direction and regression test without editing source. Record clean-review conclusions narrowly: no confirmed
  issue observed in the analyzed change and blast radius is not proof the project is vulnerability-free.
- The host creates SARIF from the validated structured ledger after your process exits. Do not hand-author SARIF
  or duplicate free-form findings outside the ledger.

## Deliverable

Write `SECURE_REVIEW.md` with: comparison identity; concise verdict; analyzed change/blast-radius coverage;
confirmed findings ordered by severity; unresolved candidates; dismissed candidate summary when material;
positive controls; recommended fixes/tests; unrelated pre-existing context; stale/unresolved/excluded coverage;
and final counts. Every finding must state the exact change that caused it and its full affected path.

## End of phase

Call `handoff` once with `artifact: "SECURE_REVIEW.md"`, target `complete`, and final confirmed/suspected counts
plus the review verdict. Include `completion` with title `Secure review completed`, a concise Markdown summary,
and artifacts for `SECURE_REVIEW.md` and `reports/secure-review.sarif`. Then stop.
