---
name: audit-api-contract-implementation
description: Audit whether API handlers, gateways, serializers, validators, and generated clients implement the effective contract and its security invariants. Use for code-level REST, RPC, OpenAPI, schema-enforcement, versioning, and undocumented-route reviews.
metadata:
  domain: application-security
  subdomain: api-contract-assurance
  triggers:
    - audit API contract implementation
    - compare OpenAPI to handlers
    - find undocumented API routes
    - review request response schema enforcement
    - audit generated API clients
  tags:
    - API
    - OpenAPI
    - schema-validation
    - route-registration
    - code-audit
  frameworks:
    nist_csf:
      - PR.PS
---

# Audit API Contract Implementation

Treat the deployed route table and executable validators as the effective implementation. Treat OpenAPI, protobuf, WSDL, generated clients, examples, and gateway configuration as independent claims to reconcile, not as proof of runtime behavior.

## Establish the contract set

Identify contract versions, route registration, middleware order, serializer settings, compatibility adapters, gateway rewrites, and generated artifacts. Record which artifact owns each operation and whether production can expose routes outside it.

Read [contract-implementation-review.md](references/contract-implementation-review.md) when tracing handler registration, validation, and drift. Use `analyze-api-contract-coverage` when OpenAPI JSON and implementation inventories need a deterministic coverage ledger. Route gRPC or SOAP protocol behavior to their dedicated skills.

## Trace security invariants

For each representative operation, follow path, query, headers, metadata, body, identity, tenant, authorization, validation, coercion, side effect, error mapping, and response serialization. Verify that contract-required security is enforced by executable code and that optional, nullable, defaulted, polymorphic, unknown, and duplicate fields cannot change the security decision.

Compare every alternate entrypoint: version aliases, batch routes, internal adapters, async consumers, generated server stubs, direct service calls, and gateway bypasses. Check that deprecation does not leave weaker validators or authorization.

## Report evidence-backed drift

Classify each discrepancy as undocumented implementation, unimplemented contract, validation mismatch, security-declaration mismatch, compatibility divergence, or evidence gap. A mismatch becomes a vulnerability only when it violates a security requirement; cite the exact contract location and executable path that establish the difference.
