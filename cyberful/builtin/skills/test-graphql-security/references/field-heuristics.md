# GraphQL Field Heuristics

## Resolver-path matrix

For one protected object or field, compare access through:

- direct root lookup and list traversal;
- node/global-ID lookup;
- parent relationship in both directions;
- interface and union fragments;
- alias and repeated-field merging;
- mutation return payload and error extension;
- subscription initial event and later events;
- federation entity/reference resolution;
- persisted and arbitrary operation paths.

Authorization often exists on the obvious root but not on sibling resolver paths.

## Identity and cache traps

- DataLoader key contains object ID but omits tenant, principal, locale, visibility tier, or policy version.
- A loader is process/request global when the framework assumes request scope.
- Context is captured before async identity/tenant switching or lost in a subgraph call.
- Gateway authorizes a field but subgraph exposes it through entity resolution or another gateway.
- Response/cache keys normalize query text but omit variables, operation name, headers, client, or authorization context.
- Partial data assembled before an authorization error remains in the response.

## Coercion differentials

Compare literal versus variable input; omitted versus null; scalar versus singleton-list coercion; integer boundaries and float/non-finite behavior; duplicate JSON keys at the HTTP parser; custom scalar serialize/parseLiteral/parseValue; enum case; unknown input fields; upload map duplication; and gateway versus subgraph coercion. Follow the value into the resolver-validation errors alone are not findings.

## Federation-specific review

Map entity keys, resolvable flags, requires/provides/override/shareable semantics, ownership migration, subgraph-direct exposure, header/claim propagation, representation validation, and composition-time versus runtime policy. Test whether a representation can select an entity in another tenant or populate fields that the owning subgraph treats as trusted.

## Cost bypass motifs

- aliases duplicate an expensive resolver despite field merging expectations;
- list cardinality defaults or nested pagination multiply below the cost model;
- fragments/interfaces/unions expand runtime work beyond static estimates;
- batch arrays, multi-operation documents, persisted-query registration, or subscriptions bypass per-operation limits;
- errors still trigger downstream calls or retries;
- federation fan-out and N+1 occur outside gateway accounting;
- introspection is cheap but suggestion generation or validation is expensive;
- custom scalars perform parsing, regex, decompression, or remote lookup before complexity rejection.

Use tiny probes and server metrics/traces to establish amplification; never infer denial-of-service from query shape alone.

## False-negative traps

Disabled introspection, stale public schema, deprecated fields ignored, clients containing persisted documents not mined, WebSocket protocol/authorization omitted, only root resolvers tested, direct subgraph path missed, DataLoader scope assumed, and cost limits tested with one operation but not batching or subscriptions.
