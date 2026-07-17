# Financial, Inventory, and Entitlement Workflows

## Pricing and checkout

Derive price, currency, tax, discount eligibility, quantity, shipping, recipient, merchant, and inventory server-side. Bind quotations to expiry and context. Recalculate before capture or fulfillment. Prevent negative, fractional, overflow, stale, cross-account, and incompatible discount combinations.

## Payments and settlement

Authenticate provider events, verify current provider state where needed, bind amount/currency/merchant/order, enforce idempotency, handle delayed and duplicate events, and separate authorization, capture, settlement, refund, dispute, and chargeback states.

## Refunds and credits

Prevent cumulative refunds above settled value, refund after chargeback without policy, duplicate compensation across channels, self-approval, refund to unintended instrument, and entitlement retention after reversal unless explicitly intended.

## Inventory and scarce resources

Define reservation, expiry, purchase, cancellation, fulfillment, return, and release atomically. Use authoritative constraints and reconciliation. Test controlled concurrency only with synthetic or reserved inventory.

## Entitlements and subscriptions

Bind grants to settled state, plan, tenant, seat, period, and resource. Handle upgrade, downgrade, proration, cancellation, refund, grace, trial, renewal, failed payment, dispute, and reactivation without stale access or duplicate value.

## Evidence

Prefer immutable ledger entries, provider event IDs, state-transition logs, database constraints, and final authoritative records over UI messages or single service responses.
