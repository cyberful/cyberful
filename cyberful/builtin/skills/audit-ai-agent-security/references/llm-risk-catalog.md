# LLM Application Risk Catalog

## Required Injection Sources

Cover direct, indirect, stored, retrieved, multimodal, tool-output, tool-error, memory-resident, cross-agent, delegated, and fallback-route injection. Test encoding, translation, summarization, quotation, chunk boundaries, metadata, comments, alt text, OCR, hidden document layers, delayed activation, multi-turn state, and payloads gated on a later tool result.

Measure whether the content changes a security decision, identity, destination, recipient, approval, tool, argument, disclosure, memory write, or downstream effect. Textual compliance without a security-relevant effect is evidence of influence, not by itself a vulnerability.

## Disclosure and Synthetic Secrets

Trace system and developer instructions, conversation context, retrieved documents, metadata, tool output, other users or tenants, provider logs, caches, memory, workspace files, environment configuration, and credential stores.

Create engagement-owned canaries that resemble `.env`, cloud keys, SSH keys, signing material, API tokens, or secrets. Prove only the read boundary and, when authorized, propagation to an inert controlled sink. Never extract or transmit unrelated real secrets.

## Execution and Network Escalation

When mapped capabilities exist, triage:

- SSRF to authorized loopback, RFC1918, internal-service, and metadata-simulator canaries;
- shell or notebook execution using a harmless unique marker;
- template, expression, SQL, Markdown, HTML, CSV, or command interpretation;
- plugin, package-manager, extension, and MCP loading paths;
- parser URL fetch, archive traversal, SVG/HTML active content, OCR, metadata, and deserialization;
- authenticated browser actions and URL-based exfiltration;
- email, webhook, messaging, deployment, signing, IAM, or secret-manager effects.

Stop after proving the primitive with non-destructive evidence.

## Retrieval, Tenant, and Agency Failures

Test cross-tenant retrieval, namespace confusion, stale ACLs, shared cache, neighboring chunks, confused deputies, identity inheritance, recursive delegation, retry amplification, fallback policy gaps, model downgrade, denial-of-wallet, and irreversible or externally visible actions.

Compare streaming and non-streaming paths. Verify that guards apply before each tool effect, not only to final output. Verify that recovery and retry do not replay a prior side effect.

## Improper Output Handling

Follow model output into HTML, Markdown, URLs, CSV, spreadsheets, SQL, code, templates, shell arguments, logs, API fields, tool schemas, and another agent. Apply the security rules of the actual downstream interpreter and encode at that boundary.
