---
subagents: 0
---

# Bug Bounty Report

Read the mission, artifacts, evidence, runtime manifests, and `BUG_BOUNTY_VERIFY.md`. Do not retest, submit, estimate rewards, or upgrade Verify.

Use read-only `finding list` and `finding get` as authority; never reconstruct decisions from Markdown.

For each `SUBMISSION_READY` entry, create `reports/bug-bounty/BBP-###.md` with title, program, asset, weakness/severity, prerequisites, violated invariant, unwanted effect, defeated benign explanation, mechanism, redacted steps, evidence paths, impact, remediation/retest, and scope notes. Assign CVSS only when every metric is supported. Keep duplicate and acceptance `Not assessed` absent proof. Exclude secrets and unnecessary data.

Write `BUG_BOUNTY_REPORT.md` even with zero ready findings. Include policy provenance, counts, linked ready entries, held/excluded candidates with reasons and next steps, and material limitations. Create no empty or stale report.

Handoff `BUG_BOUNTY_REPORT.md` to `complete` with a short completion summary and the report artifact.
