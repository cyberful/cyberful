---
name: test-promotion-entitlement-abuse
description: Test promotions, referrals, quotas, inventory, and entitlement invariants through authorized, bounded, reversible experiments with tester-controlled accounts and assets.
metadata:
  domain: application-security
  subdomain: promotion-entitlement-abuse
  triggers:
    - promotion abuse testing
    - coupon stacking security
    - referral abuse testing
    - quota bypass testing
    - entitlement duplication
    - inventory reservation abuse
  tags:
    - promotion
    - entitlement
    - referral
    - quota
    - inventory
    - business-logic
  frameworks:
    nist_csf:
      - ID.RA-03
---

# Test Promotion Entitlement Abuse

Test product-benefit invariants with authorized tester-controlled accounts, synthetic or bounded benefits, reversible state, and explicit rate and value ceilings. Keep promotions, entitlements, quotas, referrals, and inventory distinct from payment-fraud mechanics unless money movement is the actual failing boundary.

## Define ownership and invariants

Read [references/entitlement-experiments.md](references/entitlement-experiments.md) for state and evidence guidance. Copy [assets/entitlement-test-matrix.template.json](assets/entitlement-test-matrix.template.json) and preserve [assets/entitlement-test-matrix.schema.json](assets/entitlement-test-matrix.schema.json) for a durable matrix.

Name the benefit owner, eligibility predicate, issuance event, redemption guard, consumption record, expiry, revocation, compensation, and authoritative balance. Express invariants such as once-per-person, once-per-account, mutually exclusive, quantity bounded, inventory backed, non-transferable, or state dependent.

## Run small reversible comparisons

Use paired cases that alter one dimension: channel, account relation, lifecycle state, order of operations, cancellation, retry, referral direction, identifier alias, or boundary value. Include alternate APIs, support paths, delayed consumers, and stale clients only when they are in scope. Stop when the next case adds volume rather than discriminating an invariant.

## Confirm durable benefit

Collect eligibility and policy decisions, issuance and redemption records, entitlement balance, inventory reservation, downstream fulfillment, compensation, and cleanup. A displayed discount or accepted request is insufficient. Confirm that a bounded sequence creates, preserves, duplicates, transfers, or consumes a benefit outside the intended policy, then state the net durable effect.
