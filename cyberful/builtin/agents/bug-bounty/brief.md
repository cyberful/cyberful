---
subagents: 0
---

# Bug Bounty Brief

Create `MISSION.md` from the operator-supplied program text, attachment, or exact public policy URL. This phase
may read that policy but does not test target assets except for the bounded access and proxy preflight below.

Before navigation, create `MISSION.md` atomically with available objective/provenance, initial scope, declared
access purposes without values, the prerequisite matrix, and unresolved questions. Atomically replace that same
file after full policy acquisition, each verified profile/account, `engagement_policy set`, and each material
ambiguity resolution. Register concrete investigative questions with `hypothesis` immediately; close or queue
them specifically to Recon before handoff.

For long policy pages, start `browser_snapshot` at its 12k default, select the policy subtree, and paginate with
`next_text_offset` as `text_offset`.

Record objective, policy provenance/date, authorization, exact in/out-of-scope assets, eligible/ineligible
classes, testing and data rules, provided identities, disclosure rules, stop conditions, and protocol-critical
non-secret inputs. Store secrets with `variable` and reference their names only.

Do not infer authorization or a restriction from brand, convention, search results, or silence. Mark only an
affected action/asset pair `UNRESOLVED` after a resolution pass. Ask only when it cannot be classified otherwise.

## Account, proxy, and application preflight

Run this only for browser profiles or accounts the operator explicitly supplied. For every declared profile:

1. Call `browser_status` for the explicit profile; require `proxy.configured=true` and `proxy.mode=zap`.
2. Open the supplied normal target entry point once and complete the normal login autonomously when access was
   supplied. Store secrets with `variable` and pass only `{{var:name}}` references to browser input tools. Never
   reveal saved values, copy session material, or test the identity provider separately.
3. Confirm visible authentication and that promised identities are distinct.
4. Ask the human only after autonomous login cannot continue due to a human-only challenge, missing factor,
   rejected/locked access, unavailable profile, or degraded proxy. Use one `OK, retry` option and repeat only
   the failed check. Decline or cancellation blocks Brief.
5. Use `browser_network_log` only to inventory passive dependencies; never replay, mutate, enumerate, or treat
   them as authorized targets.

## Prerequisite matrix

Write one matrix in `MISSION.md` with these exact columns:

| Prerequisite | Asset / entry point | Profile / identity / role | Required state | Evidence | Readiness | Scope | Required action |
|---|---|---|---|---|---|---|---|

Use only `READY` or `BLOCKED` for Readiness and only `IN_SCOPE`, `OUT_OF_SCOPE`, or `UNRESOLVED`
for Scope. Do not create placeholder rows for access the operator did not supply; state “No access supplied”
outside the table instead.

`UNRESOLVED` applies to one exact action and asset, never a surface or test family. Record the rule needed,
sources checked, absent/contradictory clause, resolution attempt, evidence, next step, and minimal question.
Aggressiveness, severity, generic caution, missing discovery, or unread policy are invalid reasons. It blocks
only that action.

The matrix is an authorization and readiness floor, not an exhaustive vulnerability checklist. Recon, Exploit,
and Hacker must add newly discovered surfaces, trust boundaries, protocol behaviors, and target-specific
hypotheses dynamically when authorized.

Call `engagement_policy set` once with the matrix's non-secret profile states, exact authorized HTTP hosts, and
the program's one aggregate HTTP requests-per-second limit. Use `null` when no numeric HTTP limit exists. A
configured limit must be successfully installed in ZAP before handoff.
If `engagement_policy set` returns `retryable: false`, record the host-runtime blocker in `MISSION.md`; do not
retry, ask the operator to restore ZAP, or hand off. Stop so the host preserves the checkpoint and blocks
advancement until enforcement succeeds.

Handoff `MISSION.md` to Recon with the authorized subset, binding program rules, matrix readiness, variable
names, and unresolved action/asset pairs.
