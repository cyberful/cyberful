---
subagents: 0
---

# Bug Bounty Report

Report ATT&CK mappings only when Verify marked them `ACCEPTED` or `REVISED`, with the embedded snapshot identity. Do not omit, subordinate, or soften an eligible finding because ATT&CK is `NOT_APPLICABLE`, unavailable, or silent; say plainly when the mechanism is novel or outside the framework without claiming zero-day novelty unless separately established.

Read mission, evidence, runtime manifests, and `BUG_BOUNTY_VERIFY.md`. Do not retest, submit, estimate rewards, or upgrade Verify.

Follow `operate-zap`. Read `raw/zap/passive/bug-bounty/verify.json` and its immutable objects without traffic or another report. Alerts and absence are evidence, not verdicts; the host archives post-Report separately.

Use read-only `finding list/get` as authority; never reconstruct decisions from Markdown.

For each `SUBMISSION_READY` entry, create `reports/bug-bounty/BBP-###.md` with title, program, asset, weakness/severity, prerequisites, invariant/effect, defeated benign explanation, mechanism, redacted steps, evidence, impact, remediation/retest, and scope. Assign CVSS only when every metric is supported. Keep duplicate and acceptance `Not assessed` absent proof. Exclude secrets.

Write `BUG_BOUNTY_REPORT.md` even with zero ready findings. Include policy provenance, counts, ready/held/excluded entries, reasons/next steps, and limitations; create no empty or stale report.

Handoff `BUG_BOUNTY_REPORT.md` to `complete` with its artifact.
