---
name: test-graphql-security
description: Test and audit GraphQL schemas, resolvers, subscriptions, federation, batching, authorization, data exposure, input coercion, introspection, persisted operations, complexity, and denial-of-wallet risks. Use for GraphQL endpoints, gateways, subgraphs, schema registries, Apollo-style federation, Relay connections, and GraphQL-over-WebSocket assessments.
---

# Test GraphQL Security

Treat the schema as an attacker-controlled query language and every resolver edge as a potential authorization and cost boundary.

## Acquire the effective schema

Use authorized introspection, documentation, client queries, persisted-operation manifests, schema registries, gateway configuration, frontend bundles, errors, and source registration. Do not infer absence from disabled introspection.

Map types, interfaces, unions, fields, arguments, directives, mutations, subscriptions, custom scalars, deprecated fields, federation entities, and root operations. Read [references/schema-resolver-review.md](references/schema-resolver-review.md).
Use [references/field-heuristics.md](references/field-heuristics.md) for resolver identity, federation, batching, cache, and cost differentials.

## Test resolver authorization

Check authorization at root and nested fields, object and property levels, list edges, node lookup, global IDs, mutations, aliases, fragments, interfaces, unions, federation entity resolution, DataLoader caches, subscriptions, and error paths. Verify context identity and tenant are not lost across async execution.

## Test input semantics

Inspect custom scalars, input objects, unknown and omitted fields, nullability, defaults, enum fallbacks, duplicate keys, numeric bounds, list length, recursive input, upload mappings, directives, variables, and coercion differences between gateway and subgraph.

## Test batching and composition

Assess aliases, multiple operations, array batching, automatic persisted queries, GET requests, fragments, recursive relationships, pagination, nested list multiplication, N+1 behavior, federation fan-out, subscription fan-out, and cache or DataLoader key isolation.

Read [references/cost-and-abuse.md](references/cost-and-abuse.md) before complexity tests. Use static cost estimation and tiny representative queries; never create unbounded load.

## Test exposure and errors

Review schema descriptions, deprecations, stack traces, validation suggestions, resolver errors, hidden administrative fields, internal identifiers, over-broad types, field-level privacy, and whether partial responses expose data after one authorization failure.

## Audit persisted operations

Verify hash-to-document binding, tenant and client scoping, registration authority, allowlist enforcement, cache keys, variable validation, operation versioning, fallback to arbitrary queries, and invalidation after schema or policy changes.

## Confirmation standard

Confirm with the smallest query that distinguishes the vulnerable resolver, field, relationship, or cost mechanism. Record normalized query, variables, actor, expected policy or cost, resolver path, response or measured effect, and control case.

## Authoritative anchors

- OWASP GraphQL Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html
- GraphQL specification: https://spec.graphql.org/
- GraphQL over HTTP: https://graphql.github.io/graphql-over-http/draft/
