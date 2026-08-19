---
name: test-rag-isolation-integrity
description: Test authorized retrieval-augmented generation boundaries for tenant isolation, corpus attribution, retrieval integrity, poisoned-content influence, citation fidelity, and protected-data crossover using benign canaries and matched queries.
metadata:
  domain: ai-security
  subdomain: rag-isolation-integrity
  triggers:
    - test RAG isolation
    - retrieval tenant crossover
    - vector store authorization test
    - RAG poisoning assessment
    - citation integrity validation
  tags:
    - RAG
    - retrieval
    - tenant-isolation
    - canaries
    - provenance
    - poisoning
  frameworks:
    mitre_atlas:
      - AML.T0070
    nist_csf:
      - PR.AA-05
      - PR.DS-01
    nist_ai_rmf:
      - MEASURE 2.7
---

# Test RAG Isolation and Integrity

Treat ingestion authority, corpus ownership, embedding metadata, retrieval filters, reranking, prompt assembly, citations, and answer generation as separate boundaries. Use only benign canaries and tester-owned documents; a surprising answer is not evidence until the retrieved source and protected effect are attributable.

Read [rag-isolation-method.md](references/rag-isolation-method.md) before designing control/candidate queries or interpreting citation and retrieval evidence.

For bounded HTTP probes in Pentest or Bug Bounty, stage [scripts/run_rag_isolation_probe.py](scripts/run_rag_isolation_probe.py), its [manifest](scripts/manifest.json), and the [example](assets/rag-isolation-probe.example.json). The helper invokes fixed `curl`, accepts attribution and defense-in-depth limits rather than authority, resolves authorization only from `CYBERFUL_RAG_AUTHORIZATION` after full preflight, and obtains non-loopback route and trust solely from Cyberful runtime environment. It is unavailable for Code Audit target traffic.

## Establish matched evidence

Create a control and candidate that differ in one identity, tenant, corpus, filter, or canary condition. Preserve the declared corpus, retrieved document identifiers, citation targets, response bytes, downstream tool use, and cleanup evidence. Distinguish retrieval crossover from model prior knowledge by using unique non-secret markers.

Report only a demonstrated confidentiality, integrity, authorization, or provenance invariant failure. Route prompt-only behavior to `test-ai-prompt-injection` and host capability enforcement to `test-ai-tool-authorization`.
