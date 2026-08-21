---
name: analyze-http-traffic-evidence
description: Transform bounded HAR captures into deterministic HTTP evidence about methods, origins, paths, status classes, header presence, redirects, cookies, and body sizes without replaying traffic or emitting vulnerability verdicts.
metadata:
  domain: evidence-analysis
  subdomain: http-traffic
  triggers:
    - analyze HTTP traffic evidence
    - HAR security analysis
    - inspect captured web requests
    - correlate HTTP transactions
    - review proxy traffic offline
    - summarize HTTP evidence
  tags:
    - http
    - har
    - traffic-analysis
    - web-evidence
    - offline-analysis
    - correlation
  frameworks:
    nist_csf:
      - DE.AE-03
---

# Analyze HTTP Traffic Evidence

Use this skill after requests have already been captured through an authorized browser, proxy, or harness. It analyzes immutable local evidence and never replays a request.

## Normalize without losing provenance

Read [references/http-evidence-method.md](references/http-evidence-method.md). Stage [scripts/analyze_http_traffic_evidence.py](scripts/analyze_http_traffic_evidence.py), [assets/http-traffic-analysis.example.json](assets/http-traffic-analysis.example.json), and [assets/http-traffic-analysis.schema.json](assets/http-traffic-analysis.schema.json). The analyzer accepts confined regular HAR files, snapshots their bytes in memory, records each digest, and emits only bounded structural fields under [assets/http-traffic-evidence.schema.json](assets/http-traffic-evidence.schema.json).

Interpret evidence tags as routing aids: status class, authorization-header presence, cookie issuance, redirect origin changes, and size relationships are observations, not vulnerabilities. Return to the original capture for exact values, timing, and bodies; do not infer server behavior from a single client-side record.

## Reconcile transactions

Compare authenticated and unauthenticated captures, roles, tenants, methods, content types, cache states, retries, and redirects only when capture conditions are known. Preserve source path, source digest, HAR entry index, and normalized URL components for every conclusion.
