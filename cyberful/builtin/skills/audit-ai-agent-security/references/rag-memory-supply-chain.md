# Retrieval, Memory, and AI Supply Chain

## Ingestion and Retrieval

Trace source authorization, upload, parsing, URL fetch, archive expansion, OCR, metadata extraction, chunking, embedding, indexing, filtering, query rewriting, reranking, context assembly, citations, cache, update, and deletion. Verify tenant and document ACLs at query time and again after parent-document joins.

Test metadata-filter injection, namespace confusion, stale ACLs, shared caches, deduplication, document replacement, hidden content, chunk-boundary manipulation, ranking domination, parser SSRF, archive traversal, SVG/HTML behavior, OCR-only instructions, and neighboring-chunk leakage.

## Memory and Persistent Poisoning

Classify conversation, summary, profile, task state, episodic, vector, and shared memory. Record writer, reader, tenant, provenance, confidence, retention, correction, deletion, and whether content reaches a privileged later run.

Place a benign unique marker through each authorized memory-write path. Verify whether it survives restart, crosses identity or tenant boundaries, changes later tool use, or propagates into artifacts, capsules, handoffs, delegated agents, and fallback routes. Remove the marker after the test.

## Agent and Artifact Supply Chain

Inventory base model, adapter, tokenizer, embedding model, prompt template, policy classifier, evaluation gate, dataset, registry, quantization, conversion, runtime, plugin, MCP server, skill, generated artifact, handoff, and provider setting. Bind releases to immutable artifacts and regression evidence.

Test whether generated instructions, tool schemas, capsules, reports, code comments, or dependency metadata become trusted input for another agent or interpreter. Test downgrade and recovery routes for missing controls.

## High-Yield Discriminators

- Compare vector, keyword, hybrid, reranked, cached, and parent-document retrieval paths.
- Delete a source and verify embeddings, summaries, caches, citations, and memory are also removed.
- Compare authorized citations with the actual text used in the answer.
- Change an embedding or reranker fixture and verify thresholds and tenant isolation still hold.
- Inject a marker into a tool error or child handoff and observe whether a privileged parent treats it as authoritative.
