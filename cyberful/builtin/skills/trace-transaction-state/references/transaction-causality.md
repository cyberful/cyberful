# Transaction Causality

## Prefer ownership over timestamps

Wall-clock order across services is weak evidence. Prefer a service-local sequence, ledger sequence, message offset, database commit identifier, idempotency record, or explicit causal link. Retain timestamps for context but state their clock and precision limits.

## Trace the full lifecycle

Include initiation, policy decision, authorization, reservation, posting, settlement, release, reversal, dispute, refund, payout, notification, and review where present. A response to the caller may precede, follow, or disagree with durable state.

## Reconcile value

Track signed value deltas in minor currency units and name the ledger owner. Separate available, pending, reserved, posted, and settled balances. Compensation is a new effect with its own evidence; it does not erase the original event.

## Interpret repeats

Repeated event identifiers or idempotency keys can represent harmless retries, deduplicated delivery, replay, or duplicate durable effects. Determine which component owns deduplication and verify the downstream effect before assigning impact.

## Preserve uncertainty

Mark missing artifacts, sampling, retention gaps, inconsistent correlation identifiers, and unsupported assumptions. A trace should make the narrowest causal claim that the evidence supports.
