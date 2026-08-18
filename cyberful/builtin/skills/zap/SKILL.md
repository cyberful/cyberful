---
name: ZAP
description: Use the engagement-owned headless OWASP ZAP runtime for browser capture, history, replay, scanning, WebSocket evidence, OAST, and reports.
keywords:
  - owasp zap
  - zap_
  - browser proxy
---

# ZAP

Use engagement ZAP under the mission and active persona; keep identities separate. Cyberful adds no ZAP-specific traffic or category restriction.

## Captured traffic and replay

`zap_history_search` is metadata-only by default; filter and paginate, then read selected IDs with `zap_history_get`. Use `include_bodies: true` only when needed.

Prefer `zap_history_replay` for a capture or bounded mutation. It retains method, destination, and captured cookies and authorization headers inside ZAP. Fetch needed bodies with `zap_history_get`; never rebuild session-bearing requests.

Use `zap_http_request` for an exact raw request without a matching capture. An origin-form request line requires the exact absolute HTTP(S) destination as `target_url`; never infer or downgrade its scheme.

## Evidence and verdicts

Treat alerts as leads until a reproducible effect and control establish a verdict. Re-derive TLS claims with `testssl`/`sslscan`/`openssl`, and application claims with `requests`/`httpx` or exact replay.

Redact and bound evidence; cite message or scan IDs. Missing visibility is not a negative result. Never reveal or copy credentials or sessions. Runtime cleans engagement state.

## Final engagement snapshot

When the active persona requests it:

1. Treat ZAP as a local evidence source. Do not navigate, replay, spider, start a scan, or otherwise create target traffic.
2. Read `zap_get_passive_scan_status`; let existing traffic finish passive analysis within budget and record an unfinished queue.
3. Call `zap_generate_workarea_report` with `file_path: "raw/zap/final-report.json"`, `template: "traditional-json"`, and `title: "Cyberful final engagement snapshot"`.
4. Cite the returned relative path. Absent history, an unfinished queue, or an empty report is missing evidence, not a negative result.
