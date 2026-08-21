# Tenant context method

Use this reference when organization or tenant context crosses transport, service, cache, queue, job, repository, or storage boundaries.

## Context tuple

Record at each event:

`order | component | boundary | authenticated tenant | asserted tenant | routed tenant | resource tenant | cache partition | job tenant | data partition | evidence SHA-256`

Use `null` for an absent or unobserved value. Do not fill gaps by copying the preceding event.

## Trace questions

- Is active tenant selected from authenticated membership or a caller-controlled alias?
- Does path, host, header, token, session, and resource metadata resolve to one canonical tenant identifier?
- Is a tenant change a separately authorized state transition, and does it invalidate tenant-scoped caches and sessions?
- Do cache keys, idempotency keys, rate buckets, and deduplication keys include the effective tenant?
- Do queue messages and jobs bind tenant at authorization time, or re-resolve it later from mutable identity state?
- Are repository filters structural and unavoidable, or optional predicates added by individual callers?
- Can global identifiers, search indexes, exports, object storage, logs, or notifications bypass the primary partition?
- Does absent, contradictory, stale, or deleted tenant context fail closed?

## Evidence standard

Correlate events by explicit request, message, job, or operation identifier. Preserve hashes of raw artifacts and stable source locations. A divergence can be legitimate translation between canonical identifiers; prove the mapping and the protected downstream effect before reporting isolation failure.
