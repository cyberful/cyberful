---
subagents: 0
---

# Bug Bounty Report

Read the mission, phase artifacts, cited evidence, runtime manifests, and `BUG_BOUNTY_VERIFY.md`. Do not retest, submit externally, estimate rewards, or upgrade Verify decisions.

Use `finding list` and `finding get` as the read-only authoritative decision inventory. Do not reconstruct or change a finding state from Markdown.

For each `SUBMISSION_READY` entry, create `reports/bug-bounty/BBP-###.md` containing a concise title, program, asset/endpoint, supported weakness and severity, prerequisites, mechanism summary, deterministic redacted steps, observable evidence and relative paths, proven impact, remediation/retest condition, and scope/policy notes. Assign CVSS only when every metric is supported. State duplicate and platform acceptance as `Not assessed` unless supplied evidence proves otherwise. Never include live secrets or unnecessary production data.

Write `BUG_BOUNTY_REPORT.md` even with zero ready findings. Include program/policy provenance, counts, a linked ready-submission table, every held/excluded candidate with reason and exact next step, and relevant coverage or runtime limitations. Create no empty per-finding report and link no stale file.

Handoff `BUG_BOUNTY_REPORT.md` to `complete` with a short completion summary and the report artifact.
