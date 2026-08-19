---
name: test-business-logic
description: Coordinate testing of product invariants and multi-step workflows across money, entitlements, approvals, quotas, inventory, onboarding, and distributed state. Use for broad business-logic coverage; use a narrower fraud, transaction, payment, promotion, automation, or concurrency specialist for the concrete mechanism.
metadata:
  domain: application-security
  subdomain: business-logic-routing
  triggers:
    - business logic testing
    - workflow invariant abuse
    - state machine security
    - entitlement abuse
    - payment workflow testing
    - transaction integrity
  tags:
    - business-logic
    - fraud
    - state-machine
    - payments
    - entitlements
    - CWE-840
    - MITRE-F3
  frameworks:
    nist_csf:
      - ID.RA
---

# Test Business Logic

Own the invariant and coverage ledger; route concrete mechanisms to specialists.

## Define the shared model

Extract falsifiable invariants from requirements, UI states, APIs, code, schemas, events, tests, support procedures, and accounting records. For each workflow record authoritative state, actors, guards, transitions, side effects, compensations, retries, expiry, and audit events. Read [references/invariants-and-state.md](references/invariants-and-state.md) for the ledger contract.

## Route the mechanisms

- Fraud threat structure and abuse actors: `assess-fraud-abuse-model`.
- Fraud-control artifacts and decision evidence: `analyze-fraud-control-evidence`.
- Cross-service causal state: `trace-transaction-state`.
- Payment authorization and value movement: `test-payment-fraud-controls`.
- Promotions, quotas, inventory, and entitlements: `test-promotion-entitlement-abuse`.
- Automated signup, credential, and resource abuse: `test-automated-account-abuse`.
- Races, retries, idempotency, and resource amplification: `test-concurrency-resource-abuse`.
- Authorization ownership across workflow states: `test-authorization-boundaries`.

Use [references/financial-and-entitlement-workflows.md](references/financial-and-entitlement-workflows.md) only to route money or access workflows. Use [references/field-heuristics.md](references/field-heuristics.md) for cross-channel seams after baseline coverage. Do not repeat specialist test procedures here.

## Integrate results

Maintain one row per invariant and discriminating sequence:

`invariant | actor | pre-state | sequence | expected state | observed state | authoritative evidence | effect | cleanup | limitation`

Confirm only a permitted, repeatable sequence that violates a named invariant. Reconcile partial failures, alternate channels, delayed consumers, support/admin paths, and authoritative records before assigning impact. Deduplicate by invariant and state owner, preserve disproved hypotheses, and separate control evidence from absence of observed abuse.
