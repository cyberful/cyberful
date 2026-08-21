# Event and Queue Boundary Ledger

Create one row per producer, destination, message type, and consumer path. Split fan-out consumers because each may derive identity, tenant, retry, and side effects differently.

## Ledger fields

Record producer identity, publish API, destination, broker policy, schema/version, message ID, correlation ID, partition key, ordering key, tenant source, consumer group, delivery guarantee, visibility/lease, maximum attempts, backoff, dead-letter destination, replay/redrive authority, idempotency key, durable effect, and evidence references.

## Matched cases

- Authorized producer and expected destination versus the same producer and adjacent destination.
- Valid tenant context versus omitted, conflicting, stale, or cross-tenant context.
- Current schema versus allowed downgrade, unknown field, default, and incompatible evolution.
- Single delivery versus duplicate, delayed, reordered, lease-expired, and redriven delivery.
- Consumer success versus crash before commit, commit before acknowledgement, poison message, and partial downstream failure.

## Interpretation

A publish acknowledgement proves broker admission only. A consumer log proves handling only. Confirm the durable or externally visible effect and reconcile retry/dead-letter state before asserting an invariant violation. Bound every replay, concurrency, and poison case in advance.
