---
name: test-payment-fraud-controls
description: Test payment decision and value-movement invariants with authorized synthetic instruments and reversible sandbox transactions. Use for card, transfer, refund, payout, and threshold abuse controls.
metadata:
  domain: application-security
  subdomain: payment-fraud-controls
  triggers:
    - payment fraud testing
    - card testing controls
    - transfer fraud controls
    - refund abuse testing
    - payment threshold testing
    - payout control testing
  tags:
    - payments
    - card-testing
    - transfer
    - refund
    - threshold
    - fraud
    - MITRE-F3
  frameworks:
    mitre_f3:
      - F1012
      - F1043
      - F1046
---

# Test Payment Fraud Controls

Test payment and value-movement invariants only with explicitly authorized sandbox rails, synthetic instruments, tester-controlled beneficiaries, bounded value, and a verified cleanup or reversal path. Do not use production customer instruments or create real merchant, issuer, or customer harm.

## Define the invariant matrix

Read [references/payment-control-testing.md](references/payment-control-testing.md) for lifecycle-specific evidence and stopping conditions. Copy [assets/payment-control-matrix.template.json](assets/payment-control-matrix.template.json) and preserve [assets/payment-control-matrix.schema.json](assets/payment-control-matrix.schema.json) when coordinating more than a few cases.

Cover the smallest discriminating set across instrument state, actor state, beneficiary age, value band, velocity, channel, device or session context, policy version, and lifecycle stage. Name the expected decision and durable effect before executing a case.

## Execute bounded comparisons

Use paired controls that change one relevant dimension. Exercise authorization, capture, transfer, payout, refund, reversal, dispute, or threshold behavior only when each operation is permitted and reversible. Stop on unexpected real settlement, non-synthetic data, uncontrolled beneficiary routing, rate-control activation beyond the approved ceiling, or inability to verify authoritative state.

## Prove the effect

Collect the risk decision and reasons, enforcement result, processor or rail response, transaction state, authoritative ledger delta, idempotency record, and cleanup result. An HTTP success, processor decline, or UI message alone is not a finding. Confirm a repeatable invariant violation and its net durable value effect.

Map only demonstrated behavior to MITRE F3: card-testing behavior to F1012, improper reversal abuse to F1043, and threshold probing to F1046. Omit the mapping when the observed mechanism differs.
