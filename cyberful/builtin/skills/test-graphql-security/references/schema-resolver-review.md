# GraphQL Schema and Resolver Review

## Schema attack surface

Inventory every root operation, node lookup, connection, mutation payload, subscription, upload, custom scalar, directive, interface, union, deprecated field, and federation entity. Mark data classification and authorization policy at field level.

## Resolver path

Trace:

`HTTP or socket context -> operation parsing -> validation -> context identity -> resolver -> loader/cache -> service or database -> field serialization -> error formatter`

Check whether policy runs before data fetch, whether child resolvers inherit trustworthy parent objects, and whether object-level authorization is repeated after global-ID or entity resolution.

## DataLoader and caches

Scope loader instances to request unless cross-request caching is explicitly safe. Include tenant, actor or policy context, resource, field selection, locale, and authorization-relevant state in cache semantics. Prevent one user's authorized load from satisfying another user's request.

## Mutations

Review input binding, server-owned fields, object lookup, precondition and state checks, transaction boundaries, idempotency, partial failure, side effects, generated events, returned object authorization, and whether nested inputs mutate relationships outside scope.

## Subscriptions

Authenticate connection and operation; authorize topic and each event; handle expiry and revocation; validate Origin for browser cookie sessions; limit connections, subscriptions, message size, backlog, and fan-out; and prevent cross-tenant topic keys.

## Federation

Verify gateway and subgraph authentication, query-plan trust, entity key authorization, ownership directives, internal fields, subgraph reachability, schema composition, propagated identity, tenant binding, and inconsistent policy across subgraphs.
