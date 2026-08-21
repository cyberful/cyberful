---
name: trace-distributed-request-causality
description: Reconstruct request and event causality across gateways, services, queues, workers, data stores, and external providers while preserving identity, tenant, authorization, retry, and side-effect evidence. Use for distributed security dataflow and incident reconstruction.
metadata:
  domain: application-security
  subdomain: distributed-causality
  triggers:
    - trace distributed request causality
    - reconstruct cross service request path
    - correlate distributed security evidence
    - trace request through queues and workers
    - analyze retry and side effect causality
  tags:
    - distributed-systems
    - tracing
    - causality
    - correlation
    - queues
    - evidence
  frameworks:
    nist_csf:
      - DE.AE
      - RS.AN
---

# Trace Distributed Request Causality

Reconstruct a directed evidence graph, not a timestamp-sorted story. Each edge must state why one event caused, forwarded, retried, derived, or observed another, and which evidence supports that relation.

Read [distributed-causality-ledger.md](references/distributed-causality-ledger.md) when correlating identifiers, clocks, retries, queues, or partial evidence.

## Build the graph

Start from a known request, message, state transition, or side effect. Collect gateway and service spans, structured logs, message metadata, database audit records, job history, provider callbacks, and client evidence. Normalize clocks and preserve original timestamps plus uncertainty.

For every node record actor, tenant, credential or delegation reference, operation, object, policy decision, trace/span/request/message/idempotency identifiers, retry attempt, state before/after, and evidence pointer. Label inferred edges explicitly and state the competing explanation.

## Locate security discontinuities

Identify where identity, tenant, scopes, object binding, policy decision, canonical input, idempotency, or trace context changes or disappears. Separate duplicate observation from duplicate execution and upstream timeout from downstream rollback or continued work.

Deliver the minimal causal chain supporting the security conclusion, unresolved gaps, confidence per edge, and the next discriminating artifact. Use `trace-identity-propagation` or `trace-tenant-context-propagation` when that single context is the primary question; use this skill when multiple services and async edges must be reconciled together.
