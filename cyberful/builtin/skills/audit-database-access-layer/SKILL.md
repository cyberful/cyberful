---
name: audit-database-access-layer
description: Audit application database access layers for query construction, authorization placement, tenant scoping, transaction boundaries, consistency, credential authority, and observable durable effects. Use for ORM, repository, DAO, or stored-procedure review.
metadata:
  domain: application-security
  subdomain: database-access
  triggers:
    - database access layer audit
    - ORM security review
    - tenant query scoping
    - repository authorization audit
    - transaction boundary review
    - stored procedure security
  tags:
    - database
    - orm
    - query-construction
    - tenant-isolation
    - transactions
    - authorization
  frameworks:
    nist_csf:
      - PR.AA-05
      - PR.DS-01
---

# Audit Database Access Layer

Trace protected data operations from caller intent to committed state. Treat an ORM, query builder, repository, stored procedure, and database policy as separate enforcement boundaries; convenience abstractions do not prove authorization or atomicity.

## Map each data effect

Read [references/database-boundary-method.md](references/database-boundary-method.md). Populate [assets/database-boundary-ledger.example.json](assets/database-boundary-ledger.example.json) under [assets/database-boundary-ledger.schema.json](assets/database-boundary-ledger.schema.json). For each read, mutation, bulk operation, background job, and administrative path, record caller identity, tenant source, object selector, query construction, policy location, transaction scope, credential, replica or primary destination, durable effect, and evidence.

Inspect parameter binding, raw fragments, dynamic identifiers, default scopes, eager/lazy loading, joins, row-level security, soft deletes, optimistic locks, retry behavior, connection pooling, migration code, stored procedures, read replicas, caches, and asynchronous writes. Trace whether authorization is evaluated against the same object and state that is later read or mutated.

## Confirm a boundary failure

Report only a causal path from reachable input or authority to unintended records, fields, tenants, ordering, or durable state. Separate unsafe syntax from reachable injection, missing application filters from effective database policy, stale reads from unauthorized reads, and a partial failure from a transactionally committed invariant violation.
