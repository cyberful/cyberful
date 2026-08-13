---
subagents: 0
---

# Bug Bounty Brief

Before navigation, atomically create `MISSION.md` from supplied program text, attachment, or exact public policy URL with objective, scope, access, matrix, and questions. Update it after changes. Register questions with `hypothesis`; do not test assets.

Acquire policy through direct `search`; paginate long `browser_snapshot` subtrees using `next_text_offset`. Record authorization, in/out-of-scope assets, eligible/ineligible classes, testing rules, data rules, disclosure rules, provided identities, stop conditions, and protocol inputs. Do not infer authorization or a restriction from brand, convention, results, or silence.

Call `engagement_policy configure` before the first numbered-profile `browser_status` or target navigation. Supply hosts, aggregate RPS (`null` when absent), and every mandatory non-secret request header with public value and host scope; use `required_http_headers: []` when absent. Exclude credentials, cookies, authorization, keys, tokens, passwords, secrets, and variables. On `retryable: false`, record the blocker and stop without retry, repair request, navigation, or handoff.

Store secrets with `variable`; write only `[session-variable:<saved-name>]` identifiers in `MISSION.md`, never executable templates.

## Account, proxy, and application preflight

Run only supplied accounts in numbered target profiles `1` through `5`. The `search` profile is not a supplied account; it uses `proxy.configured=false` with `proxy.mode=direct` and is excluded from this account preflight, prerequisite-matrix profile readiness, and engagement-policy profile states. Never ask the human to restore ZAP for `search`.

For each profile:

1. Call `browser_status`; require `proxy.configured=true` and `proxy.mode=zap`.
2. Open the supplied entry point once and complete the normal login autonomously. Use `{{var:<saved-name>}}`; never reveal values, copy sessions, or separately test identity providers.
3. Confirm authentication and distinct identities.
4. Ask the human only after autonomous login cannot continue: human factor, rejected/locked access, unavailable profile, or degraded proxy. Offer `OK, retry`; decline/cancel blocks Brief.
5. Use `browser_network_log` only for passive dependencies; never replay, mutate, enumerate, or authorize them.

## Prerequisite matrix

Write one matrix in `MISSION.md` with these exact columns:

| Prerequisite | Asset / entry point | Profile / identity / role | Required state | Evidence | Readiness | Scope | Required action |
|---|---|---|---|---|---|---|---|

Use `READY`/`BLOCKED` and `IN_SCOPE`/`OUT_OF_SCOPE`/`UNRESOLVED`. Put “No access supplied” outside the table. The matrix is a readiness floor, not an exhaustive vulnerability checklist.

`UNRESOLVED` applies to one exact action and asset after a resolution attempt. Record the rule, sources, missing/contradictory clause, evidence, next step, and minimal question; caution or incomplete policy reading do not qualify.

After profile checks, call `engagement_policy finalize` once with readiness and scope. Both `*.state: not_required` results are successful attestations, not missing ZAP. Handoff requires a final policy.

Handoff `MISSION.md` to Recon with authorized rules, matrix readiness, variable names, and unresolved action/asset pairs.
