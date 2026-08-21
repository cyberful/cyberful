---
name: audit-ai-agent-security
description: Route broad AI-agent security reviews to focused Cyberful skills across risk, model supply chain, context and capabilities, prompt injection, tool authorization, and RAG isolation. Use when an authorized LLM or agent assessment spans several AI security boundaries or the correct specialist is not yet clear.
metadata:
  domain: ai-security
  subdomain: agent-security-routing
  triggers:
    - AI agent security audit
    - LLM application security review
    - agentic AI assessment
    - MCP security review
    - RAG and tool security
  tags:
    - LLM
    - agents
    - MCP
    - RAG
    - capability-security
  frameworks:
    mitre_atlas:
      - AML.T0051
    nist_ai_rmf:
      - GOVERN
      - MAP
---

# Audit AI and Agent Security

Use this skill only to establish scope and route the work. Do not reproduce a specialist's procedure here.

## Route by security question

- Use `plan-authorized-ai-red-team` to define identities, scope, stop conditions, canaries, and coverage before active testing.
- Use `assess-ai-system-risk` for an architecture-wide AI risk assessment and control posture.
- Use `audit-ai-model-supply-chain` for model, adapter, dataset, artifact, registry, and loading provenance.
- Use `trace-ai-context-capabilities` to reconstruct instruction, memory, retrieval, identity, delegation, and tool reachability.
- Use `test-ai-prompt-injection` when untrusted content may influence model behavior across direct, indirect, stored, multimodal, or tool-result channels.
- Use `test-ai-tool-authorization` when tool selection, canonical arguments, credentials, approvals, destinations, or delegated authority are the security boundary.
- Use `test-rag-isolation-integrity` for cross-tenant retrieval, ACL drift, poisoning, cache isolation, or persistent memory integrity.

Read [agent-tool-boundaries.md](references/agent-tool-boundaries.md) only while deciding whether capability tracing or tool-authorization testing owns a chain. Read [llm-risk-catalog.md](references/llm-risk-catalog.md) only for broad coverage reconciliation. Read [rag-memory-supply-chain.md](references/rag-memory-supply-chain.md) only while splitting retrieval, memory, and supply-chain work.

## Coordinate without duplicating work

Create a shared capability and evidence ledger, assign each hypothesis to one specialist, and preserve cross-skill dependencies. A refusal, surprising text response, or prompt disclosure is not itself a vulnerability; require a failed deterministic boundary and a security-relevant effect. Keep credentials, tenant checks, destination policy, approvals, budgets, and output encoding outside model instructions.

Deliver the routing decision, uncovered surfaces, dependencies between specialists, and consolidated evidence references. Return here only when new architecture evidence changes the routing.
