---
name: test-http-intermediaries
description: Route HTTP intermediary testing across request normalization, web-cache behavior, and offline traffic evidence. Use when clients, CDNs, reverse proxies, gateways, meshes, caches, frameworks, or origins may disagree about message boundaries, routing, identity, normalization, or cache keys.
metadata:
  domain: application-security
  subdomain: http-intermediaries
  triggers:
    - http request smuggling
    - http desynchronization
    - web cache poisoning
    - cache deception
    - forwarded header trust
    - request normalization
  tags:
    - http
    - reverse-proxy
    - request-smuggling
    - cache-poisoning
    - normalization
    - routing
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test HTTP Intermediaries

Use this router to identify which HTTP interpretation boundary needs specialist handling. Read each selected specialist's `SKILL.md` completely before applying its procedure.

## Route by evidence question

- Message framing, protocol translation, duplicate fields, path/query decoding, authority derivation, forwarded headers, method handling, or hop-to-hop disagreement: `trace-request-normalization`.
- Cache keys, response-varying inputs, authenticated caching, poisoning, deception, collision, TTL, purge, or partitioning: `test-web-cache-behavior`.
- HAR, ZAP history, raw request/response captures, proxy traces, cache headers, or repeated observations requiring bounded offline normalization: `analyze-http-traffic-evidence`.

Desynchronization begins with `trace-request-normalization`; use live probes only after the predicted disagreement and safe connection model are explicit. Cache tests begin with `test-web-cache-behavior`; never place a candidate into a shared victim-reachable key without express authorization.

## Establish the shared hop model

Record every client, edge, proxy, protocol translator, gateway, mesh, framework, cache, and origin hop. Capture protocol version, connection reuse, routing authority, decoding order, header rewriting, body limits, cache partitioning, and available component logs. Preserve raw traffic before normalizing it.

Report the exact pair of components that disagreed, the bytes or semantic input that triggered the difference, connection or cache prerequisites, bounded observable effect, controls, and evidence paths. An unstable response, header reflection, or cache hit alone is a lead rather than a confirmed vulnerability.
