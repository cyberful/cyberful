---
name: operate-zap
description: Operate OWASP ZAP for browser capture, history, replay, scanning, WebSocket evidence, OAST, and reports while preserving session context.
metadata:
  domain: security-tooling
  subdomain: dynamic-proxy
  keywords:
    - owasp zap
    - zap_
    - browser proxy
  triggers:
    - inspect zap history
    - replay captured request
    - run zap scan
    - inspect websocket traffic
    - generate zap report
  tags:
    - owasp-zap
    - dynamic-proxy
    - request-replay
    - passive-scan
    - active-scan
  frameworks:
    nist_csf:
      - ID.RA-01
---

# Operate ZAP

Use engagement ZAP under the mission and active persona; keep identities separate. Cyberful adds no ZAP-specific traffic or category restriction.

## Captured traffic and replay

`zap_history_search` is metadata-only by default. Filter results, then use `zap_history_get`; set `include_bodies: true` only when needed.

Prefer `zap_history_replay`; it keeps captured cookies and authorization headers inside ZAP. Never rebuild session-bearing requests.

Use `zap_http_request` for an exact raw request without a capture. An origin-form request line requires the exact absolute HTTP(S) destination as `target_url`; never infer its scheme.

## Evidence and verdicts

Treat alerts as leads until a reproducible effect and control establish a verdict. Re-derive TLS and application claims with an independent tool or exact replay.

Redact and bound evidence; cite message or scan IDs. Missing visibility is not a negative result.

## Final engagement snapshot

When requested by the active persona:

1. Treat ZAP as a local evidence source. Do not navigate, replay, spider, start a scan, or otherwise create target traffic.
2. Read `zap_get_passive_scan_status`; record an unfinished passive queue.
3. Call `zap_generate_workarea_report` with `file_path: "raw/zap/final-report.json"` and `template: "traditional-json"`.
4. Cite the path. Empty output is missing evidence, not a negative result.
