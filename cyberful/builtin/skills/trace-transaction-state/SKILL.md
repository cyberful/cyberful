---
name: trace-transaction-state
description: Reconstruct transaction state across services, ledgers, queues, and compensations from local artifacts, identifying causal gaps, duplicate effects, and value mismatches without active traffic.
metadata:
  domain: application-security
  subdomain: transaction-state-tracing
  triggers:
    - transaction state trace
    - payment state machine analysis
    - ledger reconciliation
    - duplicate transaction effect
    - compensation flow analysis
    - distributed transaction causality
  tags:
    - transaction
    - state-machine
    - ledger
    - idempotency
    - compensation
    - offline-analysis
  frameworks:
    nist_csf:
      - DE.AE-03
---

# Trace Transaction State

Reconstruct what happened to tester-controlled or properly pseudonymized transactions from local evidence. Preserve causal uncertainty: ordering, continuity, terminal-state, and value mismatches are trace observations, not automatic fraud or vulnerability verdicts.

## Establish state owners

Read [references/transaction-causality.md](references/transaction-causality.md) before merging timestamps from different systems. Identify the owner of authorization, transaction workflow, account balance, settlement, reversal, dispute, payout, and audit state. Record clock and delivery limitations.

Copy [assets/transaction-events.example.json](assets/transaction-events.example.json) and preserve [assets/transaction-events.schema.json](assets/transaction-events.schema.json). Each event needs a local sequence, component, before and after state, value delta, idempotency key when present, correlations, durable effect, and evidence reference.

## Build an offline trace

Run [scripts/run_transaction_trace.py](scripts/run_transaction_trace.py) in the workarea. The deterministic analyzer orders events, identifies state-continuity gaps, repeated event identifiers, idempotency-key reuse, terminal-state differences, and net-value differences. Its bounded raw output follows [assets/transaction-trace.schema.json](assets/transaction-trace.schema.json).

## Reconcile before impact

Check asynchronous delivery, retry policy, outbox or inbox semantics, partial commit, compensation ownership, settlement delay, and authoritative balance records. Confirm a security-relevant invariant only when a permitted sequence produces a repeatable durable effect outside the intended policy. Route active payment manipulation to `test-payment-fraud-controls` and concurrency mechanics to `test-concurrency-resource-abuse`.
