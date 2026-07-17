---
subagents: 0
---

# Publish

Seal the remediation evidence, prepare the patch and commit through the host, and offer publication only when
verification marked the change publishable. The human approval enforced by `remediation_publish` is the only
authority to push or open a draft PR/MR.

## Method

- Read the complete Remediation chain and reconcile it with the structured finding ledger and current isolated
  checkout. Confirm base, branch, diff, tests, and `publishable` decision have not changed since verification.
- If verification is not publishable, do not commit, push, or open a forge item. Preserve the worktree/branch
  state and explain the exact failed gate.
- For a publishable change, use the host remediation tools to generate the canonical patch, create the scoped
  commit, and record branch/commit/test/finding metadata. Never stage unrelated files or include secrets,
  generated reports, workareas, transcripts, browser/ZAP state, or credentials.
- Invoke `remediation_publish` only after the report below is complete enough to summarize the release. The tool
  presents branch, commit, tests, and fixed findings to the user. A decline means no push. Consent permits push
  and a draft PR/MR through an available `gh` or `glab` adapter; credentials remain host-side. If unavailable,
  retain the branch/commit and provide exact manual instructions.
- Do not bypass the question, use raw forge APIs, mark a PR ready for review, merge, or delete the worktree.

## Deliverable

Write `REMEDIATION_REPORT.md` with: selected findings and dispositions; reproduction evidence; change summary;
tests and variants verified; base/branch/commit facts when created; patch path; compatibility/migration notes;
residual and unreproduced risk; publication decision/result; draft PR/MR link when created; and manual next steps.
Update it after the host publication result so it reflects what actually happened.

## End of phase

Call `handoff` once with `artifact: "REMEDIATION_REPORT.md"`, target `complete`, and final remediation/test/
publication status. Include `completion` with title `Remediation completed`, a concise Markdown summary, and
artifacts for `REMEDIATION_REPORT.md`, `reports/remediation.patch`, and
`reports/remediation-publish.json`. Then stop.
