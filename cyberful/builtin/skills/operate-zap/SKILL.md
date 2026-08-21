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

Use ZAP within mission and persona; keep identities separate. Cyberful adds no ZAP-specific traffic or category restriction.

## Captured traffic and replay

`zap_history_search` is metadata-only by default. Filter before `zap_history_get`; set `include_bodies: true` only when needed.

Prefer `zap_history_replay`; it keeps captured cookies and authorization headers inside ZAP. Never rebuild session-bearing requests.

Use `zap_http_request` for an exact raw request. An origin-form request line requires the exact absolute HTTP(S) destination as `target_url`.

## Evidence and verdicts

Treat alerts as leads until a reproducible effect and control establish a verdict. Independently re-derive TLS/application claims. Neither an alert nor the absence of alerts is a vulnerability verdict.

Bound/redact evidence; cite IDs. Missing visibility is no negative result.

## Host-owned passive checkpoints

After each accepted Pentest or Bug Bounty phase, host closes the gateway, filters observed HTTP(S) origins by `authorized_http_hosts`, waits ten seconds, then writes `raw/zap/passive/<workflow>/<phase>.json` and content-addressed `traditional-json` objects under `raw/zap/passive/objects/`.

Do not recreate this checkpoint or generate a complete unfiltered report. `not_applicable`: no authorized HTTP hosts; `no_observed_traffic`: none observed. `partial`/`failed` denote degradation without changing handoff.

Report reads Verify's immutable objects; later checkpoint archival. Empty filtered reports never prove security.
