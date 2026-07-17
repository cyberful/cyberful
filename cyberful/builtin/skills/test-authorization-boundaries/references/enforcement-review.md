# Authorization Enforcement Review

## Entry and identity

Verify trusted identity origin, issuer and audience checks, tenant selection, claims transformation, impersonation markers, assurance level, and revocation before policy evaluation.

## Policy decision

Require default deny, explicit action and resource context, authoritative relationship lookup, field-level policy where needed, and deterministic failure. Examine policy combinators, wildcard permissions, inheritance, deny precedence, condition evaluation, and administrative bypasses.

## Data access

Prefer tenant and authorization constraints in the authoritative query or repository operation, not filtering after broad retrieval. Check composite keys, joins, child loaders, GraphQL data loaders, ORM scopes, raw queries, bulk operations, cache keys, search indexes, and object storage paths.

## Distributed systems

Check whether queues carry trusted identity snapshots or references; whether workers re-authorize against current state; whether events remain valid after revocation; whether services trust gateway claims beyond their intended audience; and whether retries or dead-letter processing run with broader authority.

## Cache and revocation

Bind policy caches to actor, tenant, resource, action, state, policy version, and assurance. Define invalidation on membership, role, relationship, suspension, deletion, or object-state changes. Test stale-allow behavior and cache failure mode.

## Tests

Require negative tests for cross-owner, cross-tenant, lower-role, former-member, revoked, invalid-state, bulk, indirect, and asynchronous cases. A positive-only policy test suite does not establish authorization.
