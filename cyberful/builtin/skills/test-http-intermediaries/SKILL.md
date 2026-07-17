---
name: test-http-intermediaries
description: Assess disagreements among clients, CDNs, reverse proxies, load balancers, API gateways, caches, and origin servers during authorized penetration tests or code audits. Use for request smuggling and desynchronization, HTTP/2 or HTTP/3 downgrade, cache poisoning or deception, host and forwarded-header trust, path normalization, method confusion, parameter pollution, and response splitting.
---

# Test HTTP Intermediaries

## Model the Processing Chain

Enumerate every hop from user agent to application and back: CDN, WAF, edge proxy, protocol translator, ingress, service mesh, framework, cache, and downstream client. Record protocol versions, connection reuse, routing keys, normalization, decoding, header rewriting, body limits, and cache behavior.

The core question is whether two components derive different message boundaries, targets, identities, or cache keys from the same request.

Read [message-boundaries.md](references/message-boundaries.md) for desynchronization and normalization. Read [cache-routing.md](references/cache-routing.md) for routing, host trust, and cache analysis.

## Compare Interpretations

1. Establish stable baselines and connection behavior.
2. Identify one interpretation differential with harmless markers.
3. Exercise a dedicated connection or low-risk route.
4. Detect effects through response ordering, marker routing, timing, cache metadata, or origin logs.
5. Expand only after the parser model predicts the next result.

A reproducible differential with a component-level explanation outranks unstable anomalies. Bound queue and shared-cache effects so the test remains attributable.

## Audit Target and Identity Derivation

Trace scheme, authority, host, port, path, query, client IP, and TLS identity. Review trust in `Host`, absolute-form targets, `Forwarded`, `X-Forwarded-*`, rewrite headers, original URL headers, and service-mesh metadata.

Confirm whether untrusted routing data influences password-reset links, OAuth redirects, tenant selection, cache partitioning, signed URLs, internal routing, or security logging.

## Analyze Cache Semantics

For each cacheable route, derive the effective key and compare it with all response-varying inputs. Test normalization, unkeyed headers and cookies, query handling, method treatment, redirect and error caching, path extensions, and authenticated-content controls.

Differentiate:

- cache poisoning: attacker influence stored under a victim-reachable key;
- cache deception: private victim output stored at a public-looking key;
- cache-key collision: distinct security principals or resources normalized to one key.

## Report the Differential

Document the exact hop disagreement, trigger, connection and cache prerequisites, observable effect, blast radius, and deterministic reproduction. Remediation must align parsing and normalization across the entire chain; sample-string blocking is not a parser fix.
