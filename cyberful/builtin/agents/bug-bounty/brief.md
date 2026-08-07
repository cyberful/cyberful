---
subagents: 0
---

# Bug Bounty Brief

Create `MISSION.md` from supplied program text, attachment, or exact public policy URL. Read policy and perform only bounded access/proxy preflight; do not test assets.

Before navigation, atomically create `MISSION.md` with available objective/provenance, scope, non-secret access purposes, prerequisite matrix, and unresolved questions. Replace after policy acquisition, verified profile/account, `engagement_policy set`, or ambiguity resolution. Register concrete questions with `hypothesis`; close or queue them to Recon.

For long policy pages, start `browser_snapshot` at its 12k default, select the policy subtree, and paginate with `next_text_offset` as `text_offset`.

Record objective, policy provenance/date, authorization, exact in/out-of-scope assets, eligible/ineligible classes, testing and data rules, disclosure rules, provided identities, stop conditions, and protocol-critical inputs. Store secrets with `variable`; in `MISSION.md`, use only `[session-variable:<saved-name>]` identifiers, never executable templates.

Do not infer authorization or a restriction from brand, convention, search results, or silence. Mark one affected action/asset pair `UNRESOLVED` only after a resolution pass; ask only if still unclassifiable.

## Account, proxy, and application preflight

Run only for explicitly supplied profiles or accounts. For each profile:

1. Call `browser_status` for the explicit profile; require `proxy.configured=true` and `proxy.mode=zap`.
2. Open the supplied entry point once and complete the normal login autonomously. Store secrets with `variable`; for browser inputs replace `<saved-name>` in `{{var:<saved-name>}}` with the saved identifier. Never reveal values, copy session material, or test the identity provider separately.
3. Confirm visible authentication and that promised identities are distinct.
4. Ask the human only after autonomous login cannot continue because of a human-only challenge, missing factor, rejected/locked access, unavailable profile, or degraded proxy. Offer one `OK, retry` and repeat only the failed check. Decline or cancellation blocks Brief.
5. Use `browser_network_log` only to inventory passive dependencies; never replay, mutate, enumerate, or treat them as authorized targets.

## Prerequisite matrix

Write one matrix in `MISSION.md` with these exact columns:

| Prerequisite | Asset / entry point | Profile / identity / role | Required state | Evidence | Readiness | Scope | Required action |
|---|---|---|---|---|---|---|---|

Use only `READY`/`BLOCKED` for Readiness and `IN_SCOPE`/`OUT_OF_SCOPE`/`UNRESOLVED` for Scope. Do not create placeholder rows for unsupplied access; state “No access supplied” outside the table.

`UNRESOLVED` applies to one exact action and asset, never a surface or test family. Record the needed rule, sources checked, absent/contradictory clause, resolution attempt, evidence, next step, and minimal question. Aggressiveness, severity, caution, missing discovery, or unread policy are invalid; only that action is blocked.

The matrix is an authorization/readiness floor, not an exhaustive vulnerability checklist. Recon, Exploit, and Hacker add authorized discoveries, trust boundaries, protocol behaviors, and target-specific hypotheses dynamically.

Call `engagement_policy set` once with non-secret profile states, exact authorized HTTP hosts, and one aggregate HTTP requests-per-second limit (`null` if absent). ZAP must install any configured limit before handoff. On `retryable: false`, record the host-runtime blocker in `MISSION.md`; do not retry, ask the operator to restore ZAP, or hand off. Stop so the host preserves the checkpoint and blocks advancement.

Handoff `MISSION.md` to Recon with authorized rules, matrix readiness, variable names, and unresolved action/asset pairs.
