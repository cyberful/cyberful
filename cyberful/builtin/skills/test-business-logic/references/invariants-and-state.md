# Invariants and State Machines

## Invariant classes

- Conservation: value, balance, quantity, inventory, credits, or quota cannot be created unintentionally.
- Uniqueness: one redemption, grant, approval, claim, vote, identity, or entitlement per defined scope.
- Ordering: prerequisites precede irreversible or privileged transitions.
- Separation: one actor cannot perform conflicting duties or self-approve where prohibited.
- Binding: price, resource, tenant, recipient, identity, and transaction remain bound from initiation to settlement.
- Freshness: stale, expired, revoked, refunded, or superseded evidence cannot authorize new effects.
- Terminality: terminal states cannot transition without an explicit recovery path.
- Atomicity: partial completion cannot grant value without the corresponding debit, evidence, or audit state.

## State-machine record

For every transition capture:

`from | to | actor | tenant | required evidence | guard | authoritative state | side effects | idempotency scope | retry | compensation | audit`

## Adversarial transforms

Apply skip, repeat, replay, reverse, parallelize, delay, expire, cancel, substitute actor, substitute tenant, substitute object, mutate hidden field, split channel, downgrade evidence, trigger partial failure, reorder event, and replay dead-letter handling.

## Cross-component assumptions

Document every "service A assumes service B already checked" relationship. Verify the assumption at message creation, transport authenticity, schema, execution time, retry, replay, and state-change boundaries.
