---
subagents: 0
---

# Bug Bounty Brief

Before navigation, atomically create `MISSION.md` from supplied program text, attachment, or exact public policy URL with objective, scope, access, matrix, and questions. Update it after changes. Register questions with `hypothesis`; do not test assets. Before the first browser call, load and follow the builtin `operate-browser` skill.

Load `operate-mitre-attack`, call `status`, and record in `MISSION.md` the relevant Enterprise, Mobile, or ICS domain plus whether ATT&CK appears applicable. This initial assessment guides later reasoning but does not define program coverage, eligibility, reward, or the search for zero-days and program-specific defects.

Locate policy with `web_search`; read the selected exact result with agent-browser profile `search` and its versioned snapshot instructions. Record authorization, in/out-of-scope assets, eligible/ineligible classes, testing rules, data rules, disclosure rules, provided identities, stop conditions, and protocol inputs. Do not infer authorization or a restriction from brand, convention, results, or silence.

Call `engagement_policy configure` before the first numbered-profile target navigation. Supply hosts, aggregate RPS (`null` when absent), and every mandatory non-secret request header with public value and host scope; use `required_http_headers: []` when absent. Exclude credentials, cookies, authorization, keys, tokens, passwords, secrets, and variables. On `retryable: false`, record the blocker and stop without retry, repair request, navigation, or handoff.

Store secrets with `variable`; write only `[session-variable:<saved-name>]` identifiers in `MISSION.md`, never executable templates.

## Account, proxy, and application preflight

Run only supplied accounts in numbered target profiles `1` through `5`. `operate-browser` excludes credential-free `search` from readiness, the matrix, and engagement-policy profile states.

After configuration, run the `operate-browser` Brief readiness preflight for every supplied account and entry point. Record results and passive dependencies in `MISSION.md`; a `BLOCKED` profile blocks Brief.

## Prerequisite matrix

Write one matrix in `MISSION.md` with these exact columns:

| Prerequisite | Asset / entry point | Profile / identity / role | Required state | Evidence | Readiness | Scope | Required action |
|---|---|---|---|---|---|---|---|

Use `READY`/`BLOCKED` and `IN_SCOPE`/`OUT_OF_SCOPE`/`UNRESOLVED`. Put “No access supplied” outside the table. The matrix is a readiness floor, not an exhaustive vulnerability checklist.

`UNRESOLVED` applies to one exact action and asset after a resolution attempt. Record the rule, sources, missing/contradictory clause, evidence, next step, and minimal question; caution or incomplete policy reading do not qualify.

After profile checks, call `engagement_policy finalize` once with readiness and scope. Both `*.state: not_required` results are successful attestations, not missing ZAP. Handoff requires a final policy.

Handoff `MISSION.md` to Recon with authorized rules, matrix readiness, variable names, and unresolved action/asset pairs.
