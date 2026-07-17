# Business-Logic Field Heuristics

## Mine Invariants From Disagreement

The richest leads are places where two artifacts disagree:

- UI state versus accepted API transition;
- order record versus payment ledger;
- entitlement service versus billing state;
- cache or search view versus primary database;
- synchronous result versus later webhook or reconciliation;
- current policy versus grandfathered or migrated records;
- support procedure versus user-facing workflow.

Translate each disagreement into a conservation, uniqueness, ordering, binding, separation, monotonicity, or boundedness invariant.

## Temporal Seams

Test just before and after expiry, renewal, cutoff, settlement, inventory release, approval, tenant move, policy change, and scheduled reconciliation. Include clock skew, timezone, daylight-saving transitions, date-only fields, leap days, and provider timestamps when the product semantics depend on time.

Artifacts that were valid when created may be unsafe when consumed later. Verify authority, price, ownership, assurance, and state at the point of irreversible effect.

## Multi-Channel Composition

- Begin in web and complete in mobile, API, support, webhook, import, or legacy UI.
- Create through one version and mutate or redeem through another.
- Split quantity, credit, discount, quota, or approval across accounts, tenants, carts, currencies, or concurrent sessions.
- Cancel in one service while confirming or fulfilling in another.
- Use preview, quote, clone, retry, resume, or restore to re-enter a completed workflow.
- Chain a self-service action with an administrative bulk tool that assumes prior validation.

## Economic and Entitlement Clues

- Compare authorization, capture, settlement, fulfillment, refund, dispute, and chargeback as independent states.
- Test cumulative effects across partial refunds, credits, coupons, loyalty points, trials, grace periods, referrals, and proration.
- Examine rounding at every allocation boundary; sums of rounded line items can differ from rounded totals.
- Look for negative or zero values after unit conversion rather than only at input.
- Determine whether scarce inventory and entitlement are reserved, granted, and released by one authoritative transaction.

## Failure-Path Exploration

Introduce controlled timeout, duplicate delivery, stale callback, cancellation, retry, and partial downstream rejection. Observe whether compensation is idempotent and whether "failed" operations still grant value.

The failure response is not the final state. Wait for workers, provider events, and reconciliation, then inspect every authoritative record.

## False-Negative Traps

- Testing only valid happy-path account states.
- Treating an idempotency key as sufficient without binding it to actor, operation, and payload.
- Inspecting a single database while a ledger or provider owns truth.
- Ignoring support, migration, and bulk operations because they are not public.
- Testing values independently when the exploit requires a valid sequence of individually permitted operations.
