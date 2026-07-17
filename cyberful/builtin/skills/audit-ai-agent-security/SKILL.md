---
name: audit-ai-agent-security
description: Audit LLM applications, retrieval systems, multimodal pipelines, autonomous agents, tool calling, memory, model and data supply chains, and AI output consumers during authorized penetration tests or code audits. Use for direct or indirect prompt injection, excessive agency, tool abuse, cross-tenant retrieval, data poisoning, sensitive disclosure, unsafe output handling, model extraction, denial of wallet, and agent control-plane review.
---

# Audit AI and Agent Security

## Model Authority Outside the Prompt

Map model inputs, system and developer instructions, retrieved content, memory, tools, identities, approvals, output consumers, model provider, plugins, data pipelines, and human operators. Mark each trust boundary and which component-not the model-enforces it.

Treat model output as untrusted interpretation. Prompt hierarchy improves behavior but is not a deterministic authorization, confidentiality, or integrity boundary.

Read [llm-risk-catalog.md](references/llm-risk-catalog.md) for the application risk surface. Read [agent-tool-boundaries.md](references/agent-tool-boundaries.md) for capability containment. Read [rag-memory-supply-chain.md](references/rag-memory-supply-chain.md) for retrieval, memory, and model/data provenance.

## Build a Capability Graph

For each tool or action, record:

- schema and semantic capability;
- credentials and tenant context;
- resources selectable by arguments;
- read, write, execution, communication, and financial effect;
- preconditions and approval;
- return data reintroduced into context;
- retry, rollback, and idempotency;
- audit and revocation.

Derive the maximum effect of one model decision and of a multi-step chain. A read tool can become a write primitive if its content is interpreted by a later tool; a low-risk search tool can expose instructions that steer a privileged agent.

## Test Control-Data Separation

Inject benign canary instructions through every untrusted channel: user message, retrieved page, document metadata, image text, tool result, email, code comment, issue, memory, and cross-agent message. Observe whether the content alters tool selection, arguments, disclosure, destination, or approval behavior.

Vary placement, encoding, language, quoted data, delayed activation, references, and multi-turn state. The finding is the security-relevant effect, not the model following an unusual sentence.

## Validate Deterministic Enforcement

Inspect whether code outside the model constrains:

- authenticated principal and tenant;
- allowed tools and per-tool resource scope;
- structured arguments and canonicalization;
- destination and recipient;
- sensitive-data release;
- action approval and transaction preview;
- budget, iteration, concurrency, and recursion;
- memory write and retrieval scope;
- output encoding before downstream interpreters.

## Report the Failed Boundary

Provide the injected source, model decision, tool or consumer path, deterministic control that was absent or bypassed, resulting capability, reproducibility across trials, and context prerequisites. Recommend capability reduction and external enforcement before prompt changes.
