# RAG Isolation Method

## Attribution matrix

For every case record actor, tenant, corpus, ingestion owner, query, expected source set, allowed marker set, retrieval filters, reranker, answer policy, and cleanup owner. Use unique benign markers that do not resemble credentials or production data.

## Discriminators

- Repeat the same query with and without the tester-owned source to separate retrieval from model memory.
- Change one actor, tenant, corpus, filter, or document state at a time.
- Compare retrieved identifiers and citations before interpreting generated prose.
- Test stale indexes, deleted documents, metadata-only matches, chunk overlap, namespace defaults, and fallback retrieval with bounded fixtures.
- Treat an answer marker without source evidence as unresolved; treat a retrieved foreign marker as isolation evidence even when the final answer suppresses it.

## Evidence contract

Retain request attribution, source/corpus identifiers, redacted raw response, canary digests, retrieval or citation identifiers returned by the system, timing, and cleanup. Never seed real secrets or another tenant's data to create a test.
