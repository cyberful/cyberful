---
name: ZAP
description: Operate Cyberful's shared headless OWASP ZAP instance through its official MCP surface and controlled bridge for browser capture, history, replay, authentication, spiders, scans, OAST, and reports.
keywords:
  - owasp zap
  - zap_
  - browser_status
  - browser proxy
  - proxy history
  - http history
  - raw request
  - active scan
  - passive scan
  - ajax spider
  - openapi
  - graphql
  - websocket
  - oast
  - replay
  - tamper
  - idor
  - csrf
  - ssrf
  - request smuggling
---

# OWASP ZAP

One headless ZAP container belongs to the whole engagement. The isolated browser is routed through its
proxy, so ordinary navigation, authenticated XHR/fetch traffic, and WebSocket handshakes accumulate in
one history shared by recon, exploit, hacker, and verify. Drive the real journey first; inspect and
replay the captured request instead of reconstructing it from memory.

ZAP findings are leads. Confirm a vulnerability with a control and the observed effect before marking
it confirmed. Active scanning and OAST create target traffic and are allowed only when the mission and
current phase authorize that exact action.

## Readiness and automatic capture

Before the first target request, call `browser_status`. The proxy path is attested only when
`proxy.configured` is `true` and `proxy.mode` is exactly `zap`. A `pending` result is not permission to
navigate: recheck at a bounded interval, then record a platform blocker if it does not settle. A
`direct-fallback` result is explicit degraded operation; follow the mission's fallback policy and never
claim that traffic from that browser launch exists in ZAP.

There is no capture switch to call in ZAP. Once the browser status is attested, every `browser_*`
navigation and the page's HTTP, HTTPS, XHR/fetch, and WebSocket traffic traverse the proxy automatically.
Empty initial tabs are not a failure signal. After an authorized journey, prove capture by searching for
the exact origin, path, or unique non-secret marker in `zap_history_search` and reading the selected message.

All phases and any native Codex subagents share one engagement-owned ZAP history. Concurrent workstreams do
not receive isolated histories, so partition target surfaces deliberately, use exact origins and bounded
searches, preserve message IDs in handoffs, and leave final report generation to the serialized Report phase.

## Normal workflow

1. Attest `browser_status`, then use `browser_*` for the real application flow.
2. Search a bounded metadata page with `zap_history_search`; use `zap_history_get` to inspect selected
   metadata, and set `include_bodies: true` only for the smallest pair whose content is actually needed.
3. Replay the raw request with `zap_http_request`, changing one factor at a time and comparing the
   response against a control. An absolute-form request line is self-contained. For an origin-form line
   such as `GET /path HTTP/1.1`, also pass the message's exact absolute URL as `target_url`; the bridge
   rejects missing or mismatched destinations and verifies the URL ZAP actually recorded.
4. Wait for `zap_get_passive_scan_status` to reach zero, then inspect `zap://alerts` and the specific
   alert instances. Preserve scanner results as suspected until reproduced.
5. Save durable evidence in the workarea. Large or binary bridge results are written under
   `.cyberful-zap/objects/` by content hash and returned as reusable relative paths.

## Use by phase

Apply the current persona and `MISSION.md` traffic limits before choosing a ZAP capability:

- Recon drives ordinary browser journeys, reads history and passive findings, and preserves message IDs;
  it does not replay payloads, run active scans, or generate reports.
- Exploit and Hacker replay captured requests and may use spiders, active scans, authentication, or OAST
  only when the exact action is authorized and proportionate.
- Verify replays the original request and a control from captured history; an alert alone never verifies a
  finding.
- Report performs only the final local snapshot below. It does not create target traffic.

## Official MCP surface

The official ZAP add-on supplies these tools unchanged:

- information/context: `zap_version`, `zap_info`, `zap_create_context`;
- traditional spider: `zap_start_spider`, `zap_get_spider_status`, `zap_stop_spider`;
- AJAX spider: `zap_start_ajax_spider`, `zap_get_ajax_spider_status`, `zap_stop_ajax_spider`;
- active scan: `zap_start_active_scan`, `zap_get_active_scan_status`, `zap_stop_active_scan`;
- passive scan/reporting: `zap_get_passive_scan_status`, `zap_generate_report`.

Official resources include `zap://alerts`, `zap://alerts/{alertRef}`, `zap://contexts`,
`zap://history`, `zap://history/{id}`, `zap://scan-policies`, `zap://scan-status`, `zap://sites`,
`zap://sites-tree`, and `zap://report-templates`. Report paths stay inside `/zap/wrk`; the returned
`engagement_root_relative_path` is relative to the engagement root, not an individual subagent context.
The gateway blocks report generation during Recon and blocks the unscoped official report in Report.

Official prompts are `zap_baseline_scan` and `zap_full_scan`. They are forwarded as MCP prompts and can
also be retrieved through `zap_prompt_get` when the client surface needs a tool call.

## Controlled API extensions

- `zap_api_catalog` discovers operations from the installed add-ons at runtime. Filter by component or
  operation type before using the generic API.
- `zap_api_call` accepts only `{ component, type, operation, parameters }` and resolves the operation
  through that catalog. It never accepts an arbitrary API URL, and raw `core/action/sendRequest` is omitted
  so request destination validation cannot be bypassed.
- `zap_http_request`, `zap_history_search`, `zap_history_get`, and `zap_websocket_history` provide stable,
  paginated traffic workflows. Origin-form requests require `target_url`; never infer the scheme or
  destination from a `Host` header.
- `zap_generate_scoped_report` requires a non-empty list of exact HTTP(S) origins and applies ZAP's
  server-side site filter while keeping the output inside the engagement root.
- `zap_context_auth` exposes context, authentication, session management, user, and forced-user
  operations. Read the relevant catalog entries before configuring them; keep credentials in session
  variables rather than artifacts.
- Call `zap_oast` without an operation first to inspect its catalog-derived capability report. The packaged
  add-on exposes service discovery and configuration under `component: "oast"`; its HTTP API does not expose
  registration, payload generation, polling, or interaction history. Do not guess `interactsh`, `boast`, or
  `callback` subcomponents and do not improvise ZAP scripts. When the mission justifies a callback test, use an
  engagement-owned one-shot harness with a unique payload, a successful self-test, bounded polling, redacted
  evidence, and cleanup.

Lifecycle shutdown, API security weakening, listener expansion, aliases, and file transfer remain
host-owned and cannot be invoked through `zap_api_call`. File transfer is intentionally disabled.

## Final engagement snapshot

Only the serialized Report phase creates the client ZAP artifact. After all target traffic has completed:

1. Wait for `zap_get_passive_scan_status` to reach zero.
2. Derive the exact authorized HTTP(S) origins from `MISSION.md` and compare them with `zap://sites`.
   Record only the count of unexpected origins as an isolation observation; do not copy their values.
3. Generate `ZAP-REPORT.json` with `zap_generate_scoped_report`, template `traditional-json`, and only the
   authorized origins. Require matching `included_sites`, require `engagement_root_relative_path` to equal
   `ZAP-REPORT.json`, parse the root JSON, and cite it from `REPORT.md`.

If scope is ambiguous or ZAP is unavailable, record the limitation and use the saved evidence. This snapshot
does not authorize navigation, replay, spidering, scanning, direct fallback, or any other target request.

## Scanning discipline

Spidering is discovery traffic; active scanning is attacking traffic. In recon, use browser traffic,
history, passive scan, and narrowly authorized spiders only. Start active scans in exploit or hacker.
Poll status at a reasonable interval rather than busy-looping. A `403`, `429`, or managed challenge ends the
current scan and must not be retried or disguised, but it does not stop unrelated authorized work. Stop all
target traffic only for an explicit mission stop condition, scope uncertainty, systemic service instability,
unexpected private data, or an unplanned side effect.

For OpenAPI or GraphQL imports, discover the installed component operations with `zap_api_catalog`, then
call the exact `importUrl`/equivalent operation through `zap_api_call`. For WebSockets, page messages with
`zap_websocket_history`; do not pull unbounded payload history into model context.

## Local targets and TLS

ZAP runs in a container. A service on the host is reached as `host.docker.internal`, not as `localhost`
from ZAP. If the mission gives a loopback URL, report the required correction instead of silently
rewriting the hostname, `Host` header, cookies, redirects, or origin semantics.

The browser trusts only the engagement ZAP CA public key through an SPKI pin. There is no global HTTPS
validation bypass. ZAP re-signs upstream TLS, so assess the target's real certificate and cipher posture
directly with appropriate cyberful-os tools rather than inferring it from the proxied browser leg.

If ZAP is unavailable, Cyberful marks the engagement degraded and the next browser launch visibly uses
the direct fallback. Do not assume requests were recorded in that state.
