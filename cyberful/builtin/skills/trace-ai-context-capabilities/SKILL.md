---
name: trace-ai-context-capabilities
description: Reconstruct how instructions, retrieved content, memory, identities, approvals, tool schemas, arguments, outputs, delegation, and fallbacks propagate through an AI system. Use for offline causal analysis of agent traces and context boundaries before testing prompt injection or tool authorization.
metadata:
  domain: ai-security
  subdomain: context-capability-tracing
  triggers:
    - trace AI context capabilities
    - agent context dataflow
    - LLM tool causal trace
    - memory and retrieval propagation
    - agent delegation trace
  tags:
    - context-tracing
    - capabilities
    - tool-calling
    - memory
    - retrieval
    - delegation
  frameworks:
    nist_ai_rmf:
      - MAP 1.1
      - MEASURE 2.7
---

# Trace AI Context and Capabilities

Reconstruct what influenced each consequential action and which deterministic mediator authorized it. Do not infer causality from temporal proximity alone.

## Build the event graph

Normalize instruction sources, retrieval items, memory reads/writes, model calls, tool discovery, tool requests, canonical arguments, approval decisions, identity/tenant context, tool results, delegations, fallbacks, and output consumers. Read [references/context-capability-graph.md](references/context-capability-graph.md) for edge semantics.

Stage [scripts/trace_context_capabilities.py](scripts/trace_context_capabilities.py), its [manifest](scripts/manifest.json), and the [ledger example](assets/context-capability-ledger.example.json) when event volume makes manual tracing unreliable. The analyzer is offline, rejects duplicate/self/cyclic relationships, and preserves unknown parents as typed evidence gaps rather than inventing causality.

## Deliver

Identify untrusted-to-privileged paths, missing mediation, identity changes, approval/action mismatches, shared context across tenants, stale memory, fallback divergence, and evidence gaps. Route influence tests to `test-ai-prompt-injection` and host-enforcement tests to `test-ai-tool-authorization`.
