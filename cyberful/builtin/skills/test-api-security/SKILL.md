---
name: test-api-security
description: Test and audit non-GraphQL APIs across inventory, schemas, identity propagation, object and property authorization, resource governance, versioning, error handling, third-party consumption, and asynchronous effects. Use for REST, JSON, XML, gRPC, protobuf, SOAP, OpenAPI, partner, internal, mobile-backend, batch, and machine-to-machine API assessments.
---

# Test API Security

Treat every operation and message consumer as a security boundary even when a gateway or trusted client performs earlier checks.

## Reconcile the API inventory

Combine specifications, gateway routes, server registrations, frontend and mobile traffic, SDKs, client bundles, service discovery, old versions, documentation, message topics, and observed proxy history. Read [references/inventory-contract.md](references/inventory-contract.md).

Record method or operation, path or topic, version, media type, schema, authentication, authorization owner, rate and cost limits, side effects, idempotency, upstream and downstream services, and deprecation status.

## Compare contract with behavior

Test undocumented operations, alternate methods and media types, parameter locations, duplicate parameters, null and omitted fields, unknown fields, type coercion, numeric boundaries, nested depth, collections, pagination, filtering, sorting, field selection, compression, and content negotiation. Distinguish tolerant parsing from a security boundary failure.

## Test authority at every level

Apply object, property, function, relationship, tenant, workflow, and service authorization. Include collection, search, export, batch, async job, webhook, administrative, and legacy operations. Route deep authorization work to `test-authorization-boundaries`.

## Test operational abuse

Model CPU, memory, storage, bandwidth, queue, fan-out, email, SMS, payment, biometric, model-token, and third-party cost. Check pagination caps, request and response size, concurrency, expensive filters, batch width, retries, idempotency, timeouts, cancellation, and partial failure without generating uncontrolled load.

## Test identity and message propagation

Verify issuer, audience, client, tenant, subject, token type, delegation, and assurance at each service boundary. Check headers or metadata that gateways overwrite, strip, sign, or trust. Ensure background consumers do not trust attacker-controlled actor or tenant fields and re-evaluate time-sensitive authority where required.

## Test unsafe consumption

Treat upstream APIs, webhooks, feeds, files, schemas, and service responses as untrusted according to their compromise and drift model. Validate data, enforce timeouts and size limits, constrain redirects and outbound destinations, isolate credentials, handle partial or malicious responses, and prevent upstream content from entering interpreters.

Read [references/rest-rpc-patterns.md](references/rest-rpc-patterns.md) for protocol-specific checks.
Use [references/field-heuristics.md](references/field-heuristics.md) to pursue cross-layer differentials, hidden operations, and high-yield chain conditions after the baseline inventory is stable.

## Evidence standard

Record exact request or message, actor, tenant, resource, contract expectation, observed response or state, control comparison, and downstream effect. A schema mismatch, verbose error, or permissive method is a finding only when it crosses a security requirement.

## Authoritative anchors

- OWASP API Security Top 10 2023: https://owasp.org/www-project-api-security/
- OWASP REST Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
- RFC 9110 HTTP Semantics: https://www.rfc-editor.org/rfc/rfc9110
