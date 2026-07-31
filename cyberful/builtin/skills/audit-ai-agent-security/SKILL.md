---
name: audit-ai-agent-security
description: Map and aggressively test the security boundaries of LLM applications, RAG systems, multimodal ingestion, autonomous agents, tool calling, memory, delegation, model fallbacks, plugins, MCP servers, and AI output consumers during authorized penetration tests or code audits. Use for direct, indirect, stored, multimodal, tool-output, error, memory, and cross-agent prompt injection; capability and identity mapping; excessive agency; workspace or synthetic-secret access; controlled egress and SSRF; parser and code-execution chains; cross-tenant retrieval; persistent poisoning; unsafe output handling; fallback bypass; denial of wallet; and AI control-plane review.
---

# Audit AI and Agent Security

## Establish the Capability Map

Classify every AI surface as `rag_only`, `tool_enabled`, or `unknown` before testing. Record the authenticated identity, tenant, approval boundary, delegation and fallback behavior, and each reachable capability:

- retrieval source, database, vector store, memory, and cache;
- filesystem, workspace, uploads, document parsers, and generated artifacts;
- browser, HTTP, webhook, email, messaging, and network egress;
- shell, notebook, interpreter, template engine, plugin, and package manager;
- IAM, cloud, signing, deployment, secret manager, and financial actions;
- output consumed as HTML, Markdown, URL, CSV, SQL, code, shell, or another tool schema.

Map credentials and resource scope outside the prompt. Treat model instructions as behavior guidance, never as authorization, confidentiality, or integrity enforcement.

Read [agent-tool-boundaries.md](references/agent-tool-boundaries.md) for tool-chain escalation and deterministic mediation. Read [llm-risk-catalog.md](references/llm-risk-catalog.md) for the required injection and execution matrix. Read [rag-memory-supply-chain.md](references/rag-memory-supply-chain.md) for ingestion, retrieval, memory, and poisoning tests.

## Register Before Testing

Create one hypothesis before each discriminating test. Link the untrusted source, expected boundary, intended safe effect, target capability, prerequisites, and evidence path.

For every relevant chain, finish with exactly one outcome:

- `tested`: the boundary and security-relevant effect were exercised;
- `disproved`: evidence rules out the proposed primitive under tested conditions;
- `inconclusive`: a concrete prerequisite or technical limit prevented a verdict;
- `not_applicable`: the mapped architecture has no required capability.

Do not infer `not_applicable` from a refusal or a single failed payload. Do not stop at prompt disclosure when a mapped tool, parser, identity, or output consumer provides a plausible escalation path.

## Exercise the Injection Sources

Place benign canary instructions in each reachable untrusted channel:

- direct user input;
- retrieved pages, documents, metadata, comments, alt text, OCR-visible pixels, and hidden layers;
- stored memory, vector content, tool output, error text, and retry feedback;
- email, issue, webhook, code comment, generated artifact, and handoff capsule;
- another agent, delegated task, fallback model, or downgraded route.

Vary encoding, language, quoting, transformation tasks, delayed activation, multi-turn state, and tool-result prerequisites. Measure changes to tool selection, arguments, identity, destination, disclosure, approval, memory writes, or downstream interpretation. A surprising text answer alone is not the finding; the failed deterministic boundary and resulting capability are.

## Escalate According to the Map

Test the shortest safe chain first, then deepen only when evidence supports it:

1. Demonstrate instruction influence with a unique marker.
2. Demonstrate access using a synthetic canary resource created for the engagement, never an unrelated real secret.
3. Demonstrate controlled propagation to an approved local sink or collaborator endpoint.
4. Demonstrate the maximum non-destructive capability: cross-tenant read, SSRF canary, authenticated browser side effect, parser action, shell marker, or downstream interpreter influence.
5. Stop before destructive, persistent, costly, or third-party effects; report the proven primitive and bounded consequence.

Include these branches whenever the capability map supports them:

- hidden prompt or context disclosure;
- workspace reads, including synthetic `.env`, cloud, SSH, signing, API, or token-shaped canaries;
- file-read-to-controlled-egress;
- SSRF to authorized loopback, private, metadata-simulator, or internal-service canaries;
- shell, notebook, template, plugin, package-manager, or code-execution markers;
- parser SSRF, archive traversal, SVG/HTML active content, OCR, metadata, and safe deserialization probes;
- cross-tenant retrieval, stale ACL, confused deputy, or shared-cache leakage;
- authenticated browser, email-recipient, webhook, and integration side effects;
- persistent memory, artifact, capsule, and handoff poisoning;
- retry, fallback, model downgrade, streaming, or guard-order bypass;
- output injection into HTML, Markdown, CSV, SQL, shell, templates, or tool schemas;
- MCP schema/tool-discovery abuse, recursive delegation, and denial-of-wallet;
- IAM, signing, deployment, and secret-manager primitives using synthetic or read-only proof.

## Preserve Safety and Evidence

Use unique markers, hashes, local fixtures, redacted metadata, inert destinations, and least-privilege test identities. Never exfiltrate real credentials, send attacker-controlled messages to uninvolved recipients, execute destructive commands, persist uncontrolled poisoning, or incur material spend.

Record the source, exact preconditions, model decision, tool or parser path, canonical arguments, deterministic control that failed, observed effect, reproducibility, and artifact references. Distinguish provider refusal, rate limit, unavailable tooling, and genuine absence of a primitive from model avoidance.

## Recommend the Boundary Fix

Reduce capabilities and credentials first. Enforce tenant, resource, destination, recipient, egress, approval, budget, recursion, and output encoding in host or gateway code. Bind approvals to canonical resolved actions. Taint untrusted tool and retrieval output. Treat prompt changes as defense in depth.
