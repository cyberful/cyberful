# OWASP ZAP

Cyberful ships headless OWASP ZAP 2.17.0, Firefox ESR/Xvfb, its pinned add-ons,
and a bundled stdio bridge inside the unified cyberful-os image. Live-target
engagements start ZAP once in their single tooling container; phase gateways
open fresh bridge processes with `docker exec`.

Bridge-owned tool definitions live in one static catalog and are merged with
the official upstream ZAP tools at startup without renaming either surface.
The bridge exposes the complete discovered ZAP API catalog and does not enforce
an origin allowlist, redirect policy, or a separate operation denylist. This is
deliberate: the active workflow mission and agent instructions own engagement
scope, while ZAP remains a fully capable analysis runtime.

Call `zap_api_catalog` before a generic `zap_api_call`. The catalog reflects
the installed ZAP version and includes known required and optional parameters.
The bridge validates operation names and these parameter contracts locally, so
missing operations, missing parameters, and missing resources return distinct
structured errors with a bounded list of alternatives instead of an opaque
HTTP 400. In particular, `script:action:load` requires `scriptName`,
`scriptType`, `scriptEngine`, and `fileName`; `script:view:globalCustomVar`
requires `varKey`.

The browser is proxied through ZAP by default. Only internal port 8080 is
published as `127.0.0.1:<random-port>`; MCP and service control stay inside the
container. Trust is scoped to the engagement CA public-key pin, while bridge
and API keys remain host-owned private environment values.

```dotenv
CYBER_ZAP_ENABLED=1
CYBER_BROWSER_THROUGH_ZAP=1
```

Set `CYBER_ZAP_ENABLED=0` to disable ZAP or
`CYBER_BROWSER_THROUGH_ZAP=0` to keep scanning available without browser
proxying. Ordinary environment settings cannot grant target access: Pentest and
Bug Bounty Program are bounded by `MISSION.md`, while Code Audit remains offline
and never starts ZAP.

Build with `make runtime-build`, then exercise the existing unified image with
`make test-zap`. ZAP state stays in the container writable layer and disappears
when the engagement container is removed; reports written under `/zap/wrk`
persist in the mounted workarea.

Code Audit creates the unified container with `--network none` and never starts
ZAP. A ZAP process that dies is not automatically restarted: the supervisor
marks the container degraded and later bridge calls return a service diagnostic.

## Engagement rate limit

Brief writes the non-secret `raw/policy/engagement.json`. When it contains a
numeric aggregate HTTP RPS limit, Cyberful installs one Network add-on rule with
`groupBy=rule` across the authorized host patterns. Browser profiles, ZAP
replays, and proxy-aware cyberful-os clients therefore share one counter rather
than receiving separate per-host budgets. The one engagement runtime retains
the rule across phase handoffs. ZAP disabled, unavailable, or unable to accept
the rule is a hard startup failure; direct browser fallback is not allowed.

Host-side API calls use ZAP's explicit local API authority rather than proxy
routing. During Brief, the candidate policy is committed only after the rule is
accepted; a failed installation cannot leave a saved-but-unenforced policy or
permit handoff. Failures return bounded, sanitized ZAP fields together with
`retryable: false`, `user_action_required: false`, and `policy_stored: false`.
Brief records that technical blocker once and stops without asking the operator
to repair an otherwise healthy runtime from inside the run.

Gateway startup, upstream connection, tool, and shutdown failures are retained
locally in `raw/operations/runtime-diagnostics.jsonl`. Records preserve a
sanitized host/port error class and repetition count but remove credentials,
cookies, URL userinfo/query values, HTTP bodies, prompts, controls, and the full
environment. The model does not receive these diagnostics automatically.

## History replay

`zap_http_request` treats an application response as a completed tool call for
every HTTP status. Its local egress envelope records the effective host, method,
path family, and response status, so expected denials remain evidence instead
of MCP failures. ZAP API or transport failures remain tool errors.

`zap_history_replay` clones one selected history message inside ZAP and applies
up to 32 bounded header, query, or JSON Pointer mutations before sending exactly
one request. Scheme, authority, path, and method remain immutable;
`Content-Length` is rebuilt and redirects default off. Captured cookies and
authorization headers never return to the model. The result contains only
message IDs, response metadata, sizes, and the non-secret mutation summary;
call `zap_history_get` explicitly when complete bodies are required. This path
supports freshness, nonce, replay, and KMS-style payload tests without
standalone ZAP scripts.

## OAST adapter

Call `zap_oast` without an operation to read the capability contract derived
from the installed add-on's live API catalog. Supported calls are exposed under
the single `oast` component and successful calls return an explicit
`completed` result with `data` or `empty` state.

The packaged add-on's HTTP API provides service discovery and configuration;
it does not provide registration, payload generation, polling, or interaction
history. Cyberful rejects guessed `interactsh`, `boast`, and `callback`
subcomponents before transport. A justified callback test therefore uses a
separate engagement-owned one-shot harness with a successful self-test,
bounded polling, redacted evidence, and cleanup.

An individual HTTP outcome applies to the current request or scan and is not a
phase-wide stop. A request or scan that returns `429` is not retried. Continue
independent authorized work only while the target is stable; explicit mission
stop conditions, scope uncertainty, systemic
instability, unexpected private data, and unplanned side effects still stop
target traffic.
