---
name: test-event-queue-boundaries
description: Test event, message, and queue boundaries for producer and consumer authority, tenant isolation, schema enforcement, ordering, replay, retry, dead-letter, and side-effect integrity. Use for brokers, webhooks, streams, jobs, and asynchronous workflows.
metadata:
  domain: application-security
  subdomain: event-queue-security
  triggers:
    - test event queue boundaries
    - message broker security assessment
    - event consumer authorization
    - dead letter queue review
    - webhook replay test
  tags:
    - events
    - queues
    - messaging
    - replay
    - dead-letter
    - tenant-isolation
  frameworks:
    nist_csf:
      - PR.AA
      - PR.DS
---

# Test Event and Queue Boundaries

Treat producer admission, broker policy, topic or queue routing, message schema, consumer identity, tenant context, retry, dead-letter handling, and side effects as independent authority boundaries. Test only tester-owned messages and bounded delivery counts.

Read [event-queue-boundaries.md](references/event-queue-boundaries.md) for the producer-to-effect ledger and failure-mode matrix.

## Establish the delivery contract

Record producer identity, destination, partition key, schema and version, message identity, tenant source, consumer group, delivery guarantee, ordering promise, retry/backoff, visibility or lease, dead-letter policy, replay authority, and side-effect idempotency.

Use matched messages to test destination authorization, tenant confusion, field-level authority, schema downgrade, header/body disagreement, duplicate delivery, stale replay, out-of-order transition, lease expiry, poison handling, dead-letter redrive, and consumer failover. Keep concurrency and retries below mission limits.

## Confirm a broken invariant

Do not equate acceptance by a broker with an exploitable effect. Correlate publish acknowledgement, broker metadata, consumer trace, durable state, external side effect, retry history, and dead-letter outcome. Report the smallest message sequence that violates an explicit integrity, confidentiality, authorization, or availability invariant.
