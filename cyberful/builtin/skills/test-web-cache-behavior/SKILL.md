---
name: test-web-cache-behavior
description: Test authorized web-cache key construction, variation, partitioning, authenticated response handling, revalidation, poisoning, deception, purge, and TTL behavior. Use when CDN, reverse-proxy, gateway, framework, browser, or service-worker caching may cross users, tenants, routes, representations, or authorization boundaries.
metadata:
  domain: application-security
  subdomain: web-cache-security
  triggers:
    - web cache poisoning
    - web cache deception
    - authenticated response caching
    - cache key collision
    - cache partitioning
    - vary header security
  tags:
    - cache
    - CDN
    - cache-poisoning
    - cache-deception
    - partitioning
    - revalidation
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test Web Cache Behavior

Model the cache key and response-selection policy before probing. A reflected header or changing age value is not poisoning; prove that attacker-controlled input selects or changes a representation later served across an unauthorized boundary.

## Establish cache ownership

Identify every cache layer, key fields, normalization, ignored inputs, Vary handling, credential partitioning, bypass rules, cacheable status and methods, TTL, stale behavior, purge domain, and service-worker interaction. Read [references/cache-key-proof.md](references/cache-key-proof.md).

## Use isolated variants

Create a unique, authorized cache namespace that cannot collide with ordinary users. Use paired prime and observation requests with one varied dimension, a stable marker, bounded TTL, and an explicit cleanup or natural-expiry plan. Never poison a shared victim-reachable key without express authorization.

Use [scripts/run_cache_probe.py](scripts/run_cache_probe.py) for a small discriminating set. The runner requires exact origins, an explicit isolation token in every URL, and request/rate ceilings. The campaign cannot select transport: non-loopback traffic requires the proxy and CA route inherited from the Cyberful gateway after the model boundary, while literal-IP loopback traffic explicitly disables proxies. It preserves bounded raw responses without deciding exploitability.

## Confirmation standard

Report cache layer, reconstructed key, omitted or normalized dimension, prime and observation identities, response provenance, age or cache-status transition, persistence window, purge behavior, matched miss control, and unauthorized security effect.
