# Entitlement Experiments

## State owners

Identify who owns eligibility, benefit issuance, redemption, remaining balance, inventory reservation, fulfillment, expiry, revocation, and compensation. Client-visible totals are supporting evidence unless they are authoritative.

## High-value seams

Review alias identities, account linking, guest-to-member transitions, referral direction, multi-channel redemption, cart mutation, split orders, cancellation, partial fulfillment, retry, delayed events, stale eligibility snapshots, and support or administrator adjustments.

## Paired experiments

Keep benefit type, actor, and value fixed while changing one guard. Useful pairs include first versus second redemption, eligible versus ineligible state, one identifier alias versus another, before versus after cancellation, and sequential versus carefully bounded concurrent use.

## Evidence and cleanup

Record the decision, native reason, issuance or redemption event, authoritative entitlement balance, inventory or fulfillment effect, and compensation. Remove synthetic benefits and release inventory after testing. Stop if real customers, scarce inventory, production payouts, or irreversible fulfillment could be affected.
