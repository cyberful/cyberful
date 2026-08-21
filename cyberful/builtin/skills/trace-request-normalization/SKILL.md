---
name: trace-request-normalization
description: Trace how clients, CDNs, proxies, protocol translators, gateways, frameworks, and origins derive HTTP message boundaries, authority, paths, queries, and trusted forwarding metadata. Use to localize request-smuggling, routing-confusion, duplicate-field, decoding-order, or intermediary normalization hypotheses before bounded validation.
metadata:
  domain: application-security
  subdomain: http-normalization
  triggers:
    - http request normalization
    - request smuggling trace
    - proxy origin disagreement
    - duplicate header parsing
    - path decoding differential
    - forwarded header trust
  tags:
    - http
    - normalization
    - reverse-proxy
    - request-smuggling
    - routing
    - parser-differential
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Trace Request Normalization

Localize the exact adjacent pair of HTTP components that assigns different semantics to the same authorized request. A response difference without a hop-level interpretation difference is only a lead.

## Build the hop ledger

Record client, edge, cache, translator, gateway, mesh, framework, router, and origin in order. For each hop capture protocol version, connection reuse, framing owner, authority source, forwarded-field policy, path and query decoding, duplicate handling, hop-by-hop removal, body limits, and observable logs.

Read [references/normalization-ledger.md](references/normalization-ledger.md) before constructing a hypothesis. Preserve original bytes and component-local representations; do not normalize the evidence before comparison.

## Trace one semantic dimension at a time

Compare paired controls for authority, path, query, method, duplicate fields, transfer framing, content length, encoded delimiters, Unicode, and protocol translation. Predict the two component interpretations before sending any active case.

Use [scripts/run_normalization_harness.py](scripts/run_normalization_harness.py) only for safe HTTP-level variants after the exact origin, request ceiling, rate, and authorization reference are explicit. The campaign file cannot select transport: non-loopback traffic requires the proxy and CA route inherited from the Cyberful gateway after the model boundary, while literal-IP loopback traffic explicitly disables proxies. The harness does not emit malformed framing or claim request desynchronization; raw-socket or shared-connection work requires a separately approved specialist setup.

## Confirmation standard

Report the original request, both interpretations, components and versions, connection and routing prerequisites, a matched control, observable security effect, and affected authority. Do not generalize from a status code, reflection, timeout, or backend error alone.
