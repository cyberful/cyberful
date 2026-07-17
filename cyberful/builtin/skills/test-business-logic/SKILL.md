---
name: test-business-logic
description: Test and audit product invariants, state machines, payments, entitlements, approvals, quotas, inventory, pricing, refunds, onboarding, abuse resistance, and cross-service workflow integrity. Use when valid individual operations may compose into fraud, unauthorized state change, duplicate value, policy circumvention, or inconsistent records that scanners cannot detect.
---

# Test Business Logic

Start from what must never happen. Do not begin with payloads.

## Extract invariants

Interview artifacts, requirements, UI states, APIs, code, schemas, events, tests, support procedures, and accounting records to identify invariants for money, identity, entitlement, approval, inventory, quotas, lifecycle, and compliance.

Express each invariant as a falsifiable statement with authoritative state and owner. Read [references/invariants-and-state.md](references/invariants-and-state.md).

## Model the state machine

For each workflow record states, actors, evidence, guards, transitions, side effects, compensations, terminal states, retry behavior, expiry, and audit events. Include administrative, support, migration, bulk, asynchronous, and failure paths.

Test:

- skip, repeat, reverse, reorder, race, replay, or resume transitions;
- mutate server-owned values or relationships;
- apply stale, canceled, refunded, revoked, expired, or cross-tenant artifacts;
- split one logical action across channels or identities;
- exploit partial failure between services;
- reuse idempotency keys or equivalent artifacts across actor, tenant, operation, or payload;
- create valid but economically abusive sequences.

## Validate distributed authority

Identify which system owns price, payment, inventory, entitlement, approval, quota, and final state. Verify consumers validate current authoritative state rather than trusting a webhook, client, queue message, cache, or upstream status indefinitely.

## Test numbers and units

Check sign, zero, maximum, precision, rounding, currency, unit conversion, tax, discount, quantity, duplicate, overflow, underflow, and allocation semantics. Use synthetic low-value transactions and never create material financial impact.

Read [references/financial-and-entitlement-workflows.md](references/financial-and-entitlement-workflows.md) when money, inventory, or access is involved.
Use [references/field-heuristics.md](references/field-heuristics.md) to expose hidden invariants, temporal seams, and cross-channel compositions that conventional endpoint testing misses.

## Audit implementation

Trace guards and state changes through transactions, unique constraints, ledgers, outbox/inbox patterns, queues, retries, locks, caches, webhooks, scheduled reconciliation, and compensating actions. Prefer constraints that make invalid states unrepresentable.

## Confirmation standard

Confirm with a permitted sequence of operations that violates a named invariant. Record pre-state, actor, exact sequence, expected transition, observed final state, authoritative records, financial or authority effect, repeatability, and cleanup.

## Authoritative anchors

- OWASP WSTG Business Logic Testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/
- OWASP Business Logic Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html
- CWE-840 Business Logic Errors: https://cwe.mitre.org/data/definitions/840.html
