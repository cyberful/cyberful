---
name: test-concurrency-resource-abuse
description: Assess race conditions, transactional invariants, idempotency, retries, replay, rate and quota enforcement, algorithmic complexity, resource amplification, and cost abuse during authorized penetration tests or code audits. Use for TOCTOU, double spend, duplicate redemption, limit bypass, ReDoS, decompression bombs, fan-out, pagination, batch, queue, storage, compute, and unbounded-consumption risks.
---

# Test Concurrency and Resource Abuse

## Define the Invariant and Resource

Write the invariant before generating load: one redemption per entitlement, nonnegative balance, one active primary owner, monotonic state, bounded work per principal, or finite cost per request.

Map every authority that reads or writes it: API handler, database, cache, queue, worker, payment processor, scheduler, webhook, and reconciliation job. Record transaction boundaries, isolation level, uniqueness constraints, locks, compare-and-swap, idempotency stores, retries, and timeout semantics.

Read [race-idempotency.md](references/race-idempotency.md) for state races. Read [resource-amplification.md](references/resource-amplification.md) for rate, complexity, and cost review.

## Build a Deterministic Race Harness

1. Create a tester-owned object in a known state.
2. Synchronize requests as close to the final commit point as possible.
3. Vary concurrency, connection reuse, protocol, and arrival ordering.
4. Record every response, durable state, side effect, and asynchronous event.
5. Reconcile after queues and external processors settle.
6. Repeat with a matched sequential control.

Success is an invariant violation, not merely two successful HTTP responses. Use single-digit concurrency first; precision exposes more than indiscriminate load.

## Test Replay and Retry Boundaries

Follow an operation across client retries, gateway retries, queue redelivery, worker crashes, webhook duplication, provider callbacks, and reconciliation. Determine whether the idempotency key is bound to principal, operation, canonical payload, and retention window.

Test same key/different payload, different key/same semantic operation, timeout-before-response, commit-before-crash, and stale replay after state transition.

## Measure Amplification

Express cost as a function of controlled input: CPU, memory, database reads or writes, outbound calls, queue items, object count, bytes stored, response bytes, or paid third-party spend. Look for superlinear growth, recursive fan-out, and work performed before authentication, quota, or deduplication.

Rate limits must be evaluated across distributed nodes, alternate endpoints, identities, tenants, IPv4/IPv6, batch sizes, and asynchronous continuations.

## Report the Broken Invariant

Include initial state, synchronized sequence, durable final state, externally visible effects, required concurrency, consistency window, and resource cost. Recommend database-enforced invariants, atomic state transitions, bounded work, admission control, and correctly scoped idempotency.
