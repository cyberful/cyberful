# API Contract Implementation Review

Use this reference when the question is whether code and deployment implement a declared API contract. Keep a row per operation and cite both the declaration and executable registration.

## Registration and reachability

- Resolve gateway route, framework registration, version prefix, host rule, method, content type, and handler symbol.
- Include aliases, automatic `HEAD`/`OPTIONS`, batch endpoints, debug routes, generated stubs, and feature-gated registrations.
- Distinguish source definitions from the production composition root. A handler that is never registered is not an exposed operation.

## Validation and coercion

- Locate validation before the first security-relevant use, not merely a schema annotation.
- Compare required, nullable, default, enum, numeric, length, collection, union, discriminator, unknown-field, duplicate-field, and additional-property behavior.
- Trace parser and serializer settings at every hop. Generated client strictness does not constrain an attacker-controlled request.

## Security declarations

- Map contract security schemes to middleware and handler checks, including explicit anonymous overrides.
- Verify scopes, audience, issuer, tenant, object, property, function, and relationship enforcement in code.
- Compare validation and authorization ordering so rejected values cannot affect lookup, routing, logging, cache, or side effects first.

## Compatibility and errors

- Review version adapters, deprecated operations, fallback content types, and tolerant readers for weaker semantics.
- Confirm error mapping does not turn validator or downstream failures into success, leak internals, or create retry ambiguity.
- Record whether generated clients, tests, and examples cover the executable path, but do not substitute them for code evidence.

## Ledger fields

Record contract pointer, route registration, handler, request validator, response validator, identity source, tenant source, authorization owner, side effect, error mapper, observed mismatch, security consequence, and evidence references.
