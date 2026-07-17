# Retrieval, Memory, and AI Supply Chain

## Ingestion and Retrieval

Trace source authorization, parsing, chunking, metadata, embedding, indexing, filtering, reranking, context assembly, citation, update, and deletion. Verify tenant and document ACLs at query time, not only ingestion.

Test metadata filter injection, namespace confusion, stale ACLs, shared caches, deduplication, document replacement, hidden content, chunk-boundary manipulation, and ranking domination.

## Memory

Classify memory as conversation, summary, profile, task state, episodic record, vector retrieval, or shared knowledge. Define who may write, who may read, retention, provenance, confidence, correction, and deletion.

Memory poisoning becomes more reliable when an attacker can create a durable high-salience fact that later bypasses the original trust context.

## Data and Model Supply Chain

Inventory base model, fine-tune or adapter, tokenizer, embedding model, prompt templates, evaluation gates, datasets, model registry, quantization or conversion, runtime, and provider settings. Bind releases to immutable artifacts and regression evidence.

## High-Yield Hints

- Authorization metadata can be correct on chunks while parent-document joins return cross-tenant context.
- Deleting a source may not delete embeddings, summaries, caches, citations, or fine-tuning material.
- Hybrid keyword/vector search can apply ACL filters in only one branch.
- Rerankers and query rewriting can introduce content from outside the authorized result set.
- Citations may point to an authorized document while the answer includes text from an unauthorized neighboring chunk.
- A poisoned evaluation set can make a degraded or backdoored model appear safer than the previous release.
- Embedding model changes can invalidate similarity thresholds and isolation assumptions without schema changes.
