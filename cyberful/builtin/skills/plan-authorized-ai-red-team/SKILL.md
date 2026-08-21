---
name: plan-authorized-ai-red-team
description: Plan an authorized AI red-team engagement by binding models, identities, data, tools, tenants, effects, traffic, canaries, stop conditions, and evidence to explicit scope. Use before coordinated testing of LLM, RAG, agent, MCP, multimodal, or model-supply-chain systems.
metadata:
  domain: ai-security
  subdomain: red-team-planning
  triggers:
    - authorized AI red team plan
    - LLM red team scope
    - agent security rules of engagement
    - AI test coverage ledger
    - AI red team stop conditions
  tags:
    - AI-red-team
    - authorization
    - coverage
    - canaries
    - rules-of-engagement
    - evidence-ledger
  frameworks:
    nist_ai_rmf:
      - MAP 1.1
      - MEASURE 2.7
---

# Plan an Authorized AI Red Team

Turn the mission into a capability-aware test contract. This skill plans; it does not itself exercise a model or target.

## Bind authority to capabilities

Inventory model routes, retrieval collections, memory, tool registries, MCP servers, identities, tenants, secrets, output consumers, fallback paths, and human approval points. For each capability record allowed actors, data, destinations, effects, request/cost ceilings, prohibited actions, cleanup, and the evidence required to stop or escalate.

Copy [assets/ai-red-team-plan.template.json](assets/ai-red-team-plan.template.json) into the workarea. Read [references/authorization-and-coverage.md](references/authorization-and-coverage.md) before filling the ledger.

## Design discriminating coverage

Assign each hypothesis to the narrowest specialist: `trace-ai-context-capabilities`, `test-ai-prompt-injection`, `test-ai-tool-authorization`, `test-rag-isolation-integrity`, or `audit-ai-model-supply-chain`. Define one benign marker, expected safe behavior, control comparison, observable effect, maximum permitted escalation, and stop condition per hypothesis.

Never treat model instructions, refusal behavior, or a tester-authored `authorized=true` field as authority. Bind active execution to the mission, runtime route, exact identity, target tuple, and effect budget.

## Deliver

Produce the normalized scope, capability map, coverage ledger, canary register, traffic/cost budget, approval gates, cleanup owners, evidence paths, excluded effects, unresolved authorization questions, and phase handoff criteria.
