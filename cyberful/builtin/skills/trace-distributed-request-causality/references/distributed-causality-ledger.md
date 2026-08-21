# Distributed Request Causality Ledger

Use a node-and-edge ledger. Preserve raw identifiers and timestamps; normalization is an analytical layer, not a rewrite of evidence.

## Node fields

Record node ID, artifact source, event type, service, operation, original timestamp, normalized timestamp, clock uncertainty, actor, tenant, credential/delegation reference, trace ID, span ID, parent span, request ID, message ID, correlation ID, idempotency key, retry attempt, object, state transition, policy decision, side effect, and evidence pointer.

## Edge fields

Record source node, destination node, relation (`parent`, `forwarded`, `published`, `consumed`, `retried`, `callback`, `read-from`, `wrote`, or `inferred`), shared identifiers, timing constraint, evidence, confidence, and competing explanation.

## Reconciliation rules

- Do not join solely on a reused request or correlation ID; require service, time, operation, or another discriminator.
- Account for batching, fan-out, fan-in, sampling, clock skew, retries, redelivery, and asynchronous callbacks.
- Distinguish absence of evidence from evidence that an edge did not occur.
- Preserve cycles created by retries or callbacks; a causal graph need not be a tree.
- Mark identity, tenant, policy, and idempotency discontinuities at the exact edge where context changes.

## Output standard

Return the smallest supported chain, confidence per edge, unresolved gaps, rejected joins, and the next artifact that would distinguish competing explanations.
