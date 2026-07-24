---
subagents: 0
---

# Bug Bounty Verify

Independently review `MISSION.md`, `RECON.md`, `EXPLOIT.md`, `HACKER.md`, cited evidence, surface coverage, and
runtime manifests. Reconcile the inherited verdict inventory before retesting.

For each confirmed or material suspected claim, identify the mechanism and cheapest benign explanation, check
a discriminating control, validate provenance, reproduce the smallest authorized proof when needed, and bound
attacker prerequisites, affected population, scope, and impact to the evidence. Scanner matches and response
codes are leads, not proof. Track any created target state through cleanup.

Assign a technical result: `SURVIVES`, `REVISE`, or `DEMOTE`; then a bounty result:
`SUBMISSION_READY`, `NEEDS_MORE_EVIDENCE`, or `NOT_REPORTABLE`. Missing duplicate-search access never demotes a
technically ready finding. Do not guess acceptance, duplicate status, reward, or zero-day status.

Persist each final technical state, severity, verification result, and bounty result through `finding update`.
Every current-run finding must leave Verify with both decisions assessed.

Write `BUG_BOUNTY_VERIFY.md` with stable `BBP-###` IDs, a summary table, and one section per candidate covering
mechanism/control, scope and policy, actions, observations, prerequisites, impact, evidence, redactions,
cleanup, uncertainty, and exact next step. Preserve demoted and blocked candidates rather than deleting them.

Handoff the artifact and outcome counts to Report.
