---
name: test-api-security
description: Route broad non-GraphQL API assessments to focused Cyberful skills for contracts, parsers, identity, authorization, distributed causality, and protocol-specific testing. Use when an authorized REST, RPC, gRPC, protobuf, SOAP, OpenAPI, partner, batch, or machine API review spans multiple concerns.
metadata:
  domain: application-security
  subdomain: api-security-routing
  triggers:
    - broad API security assessment
    - REST API security review
    - RPC security assessment
    - machine API audit
    - API attack surface review
  tags:
    - API
    - REST
    - RPC
    - OpenAPI
    - distributed-systems
  frameworks:
    mitre_attack:
      - T1190
    nist_csf:
      - ID.RA
---

# Test API Security

Use this skill to inventory the API surface and assign each question to one specialist. Treat operations and message consumers as boundaries, but do not duplicate their detailed procedures here.

## Route the assessment

- Use `audit-api-contract-implementation` to compare implementation, gateway routes, generated clients, and schema enforcement.
- Use `analyze-api-contract-coverage` to reconcile OpenAPI or other contract coverage against observed and registered operations.
- Use `test-grpc-protobuf-security` or `test-soap-xml-services` for protocol-specific parser, metadata, and authorization behavior.
- Use `test-event-queue-boundaries` for producers, consumers, retries, dead letters, ordering, and message authority.
- Use `trace-distributed-request-causality` for identity, tenant, state, and evidence propagation across services.
- Use `test-authorization-boundaries` for object, property, function, relationship, tenant, workflow, or delegated authority.
- Use `test-concurrency-resource-abuse` for idempotency, race, quota, amplification, and bounded-load questions.
- Use `trace-request-normalization` when hop-by-hop parsing or canonicalization changes the security decision.

Read [references/inventory-contract.md](references/inventory-contract.md) to create the shared operation ledger. Read [references/rest-rpc-patterns.md](references/rest-rpc-patterns.md) only to choose a protocol owner, and [references/field-heuristics.md](references/field-heuristics.md) only for unresolved cross-layer differentials.

## Consolidate evidence

Record operation, contract version, actor, tenant, authorization owner, parser, side effect, idempotency, upstream/downstream services, and assigned specialist. A schema mismatch or permissive response is a finding only when it crosses a security requirement. Deliver coverage gaps, routing decisions, cross-specialist dependencies, and evidence references.
