# LLM Application Risk Catalog

## Prompt Injection

Cover direct, indirect, stored, cross-modal, retrieved, tool-output, memory-resident, and multi-agent injection. Test instruction/data ambiguity, encoded content, translation, summarization, quoted documents, and payloads activated only after another tool result.

Measure whether the injection changes a security decision or privileged effect. Output text alone may be harmless; the same output passed to a shell, browser, email, database, or deployment API is a different boundary.

## Sensitive Information Disclosure

Trace system instructions, secrets, retrieved documents, hidden metadata, tool output, conversation history, other users' context, provider logs, training or evaluation data, and model caches. Test both direct requests and transformation tasks that can reproduce sensitive substrings.

Prompt secrecy is not a durable control. Protect actual secrets and policies outside the prompt.

## Improper Output Handling

Follow model output into HTML, Markdown, URLs, SQL, code, templates, shell arguments, spreadsheets, documents, logs, API fields, and tool schemas. Apply the security rules of the downstream interpreter.

## Excessive Agency and Unbounded Consumption

Evaluate tool breadth, credential scope, autonomous iteration, delegation, retries, external communication, purchase or compute spend, and irreversible operations. Bound both per-action and cumulative effect.

## Poisoning, Supply Chain, and Model Behavior

Review model, adapter, prompt, embedding model, tokenizer, dataset, vector store, evaluation set, plugin, MCP server, and provider changes. Assess provenance, update control, tenant separation, and whether poisoned content persists in indexes or memory.

## Advanced Test Hints

- Ask the agent to summarize or translate hostile content; transformations often preserve its instruction semantics.
- Place the canary in metadata, alt text, OCR-visible pixels, comments, hidden document layers, or tool error messages.
- Use delayed payloads that appear inert until a specific tool, recipient, or secret is present.
- Test whether refusal on one turn still writes poisoned memory consumed later.
- Compare streaming and non-streaming paths; guards may evaluate only the final output.
- Retry and fallback models can bypass policy implemented for the primary model.
- Safety classifiers can become availability or cost oracles when their output changes retries or tool selection.
