---
name: trace-tenant-context-propagation
description: Reconstruct how tenant and organization context is authenticated, selected, routed, cached, queued, and bound to resources across distributed request paths.
metadata:
  domain: identity-security
  subdomain: tenant-context
  triggers:
    - tenant context propagation
    - organization routing trace
    - multi tenant dataflow
    - tenant cache isolation
    - background job tenant binding
    - cross tenant context analysis
  tags:
    - multi-tenancy
    - tenant-isolation
    - routing
    - cache-partition
    - queue-context
    - causal-trace
  frameworks:
    nist_csf:
      - PR.AA-05
---

# Trace Tenant Context Propagation

Trace tenant context independently from user identity. Determine which component authenticates membership, which selects the active tenant, and which binds every route, cache, job, query, and durable effect to that decision.

## Build the causal path

Read [references/tenant-context-method.md](references/tenant-context-method.md). Collect controlled request records, normalized headers and paths, identity claims, gateway and service logs, cache keys, queue envelopes, job records, repository queries, storage partitions, and response metadata.

At each event distinguish authenticated tenant, client-asserted tenant, routed tenant, resource tenant, cache partition, job tenant, and data partition. A matching user identifier does not prove tenant continuity.

## Normalize offline evidence

Use [scripts/trace_tenant_context.py](scripts/trace_tenant_context.py) with [assets/tenant-context.example.json](assets/tenant-context.example.json). Preserve [assets/tenant-context.schema.json](assets/tenant-context.schema.json) and consume the bounded raw output described by [assets/tenant-context-evidence.schema.json](assets/tenant-context-evidence.schema.json).

The analysis opens no network connection, reads no secrets, invokes no child process, and reports only field changes and non-null context divergences. Treat each divergence as a review location, not a vulnerability verdict.

## Explain the boundary failure

Identify the authoritative tenant source, the first event that diverges from it, any alias or normalization involved, and the downstream resource effect. Check whether missing context fails closed, whether cache and queue keys include tenant, and whether retries, scheduled work, exports, webhooks, or support paths re-resolve tenant safely.

Confirm impact only with paired tester-controlled tenants or code evidence that reaches a protected effect. Route the policy decision to `audit-access-policy-enforcement` and a live cross-tenant authorization matrix to `test-authorization-boundaries`.
