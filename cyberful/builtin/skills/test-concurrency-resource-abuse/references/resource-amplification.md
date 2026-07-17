# Resource Amplification and Cost Abuse

## Cost Dimensions

Model per-request and aggregate:

- parser, regex, compression, image, template, and cryptographic CPU;
- allocation, buffering, cache cardinality, and object graph memory;
- query count, join width, sort, scan, lock, and transaction duration;
- outbound requests, DNS, email, SMS, AI inference, payment, and SaaS calls;
- queue fan-out, retry storms, dead letters, and delayed work;
- storage, versioning, logs, exports, and backup multiplication;
- response expansion and streaming duration.

## Algorithmic Review

Look for attacker-controlled nesting, backtracking regexes, unbounded recursion, hash-collision-sensitive structures, quadratic concatenation, repeated canonicalization, arbitrary precision numbers, wide GraphQL or ORM associations, and sort/group over uncontrolled sets.

Measure growth across several input sizes and fit the observed trend. One slow request does not prove superlinear behavior.

## Quota Placement

Enforce admission before expensive parsing or downstream calls. Scope quotas to the scarce resource and relevant principal; IP-only limits rarely constrain authenticated or distributed abuse. Make distributed enforcement atomic enough for the threat model.

## Bypass and Chain Hints

- Batch, bulk, export, preview, validation, and dry-run routes often bypass the primary limiter.
- Aliases, case variants, multiple API versions, and IPv4/IPv6 identities split counters.
- A rejected request can still incur full parser, WAF, virus scan, or AI-model cost.
- Cache-busting fields create storage and compute amplification even with small responses.
- Retries at several layers multiply one request into geometric downstream work.
- Low-and-slow concurrency can exhaust pools or streaming slots without tripping request-per-second limits.
- Per-tenant quotas fail when unauthenticated work is attributed only after completion.
