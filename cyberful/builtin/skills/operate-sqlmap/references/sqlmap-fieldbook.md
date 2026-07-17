# SQLMap Fieldbook

## Detection tuning by query context

### Numeric expression

Look for arithmetic/boolean boundaries and type errors. Quoting payloads may be irrelevant noise.

### Quoted string

Prefix/suffix must balance quote, surrounding expression, comment behavior, and any appended clauses. Source trace beats brute boundary guessing.

### LIKE/search

Wildcards, escaping, collation, tokenization, and full-text functions can mimic boolean differences. Compare semantic controls that preserve search selectivity.

### ORDER BY / identifier

Values may select columns/directions rather than data expressions. Boolean/union techniques may miss the actual grammar; code review or structured error differentials are high value.

### INSERT/UPDATE

The observable may appear in a later read, constraint error, audit record, or side effect. Avoid assuming the immediate response contains the discriminator.

### LIMIT/OFFSET and pagination

Boundary behavior can mimic injection. Use controls inside and outside valid ranges and inspect generated query code when available.

## Request-shape traps

- duplicate query/body/cookie keys and first/last/array precedence;
- JSON numbers versus strings, null, booleans, arrays, nested objects;
- URL decoding once versus twice;
- plus-to-space handling;
- charset and Unicode normalization;
- multipart filename versus field value;
- GraphQL variables versus inline arguments;
- header canonicalization and proxy removal;
- signed requests where byte changes invalidate authentication;
- cached GET response hiding backend evaluation.

## Comparison traps

Dynamic pages require stable anchors. Configure positive/negative string, regex, status, code, title, or text-only comparison only after sampling natural variance.

Watch for:

- reflected payload changing body length;
- rotating CSRF/request IDs/timestamps;
- A/B content;
- pagination counts;
- localization;
- login/session expiry;
- WAF challenge templates;
- asynchronous processing;
- cache hits versus misses.

## Time-based proof

Use at least:

- baseline controls sampled across the same period;
- true/false or delay/no-delay payload pairs;
- randomized order;
- repeated medians/percentiles;
- safe request between tests if state drifts;
- server/application telemetry when white-box access exists.

Queueing, cold starts, locks, rate limits, and upstream retries can all produce convincing but non-causal delays.

## WAF and tamper reasoning

Before a tamper:

1. capture what left sqlmap;
2. capture what reached the application if possible;
3. identify the rejected token/shape;
4. determine which layer transformed or blocked it;
5. choose the smallest encoding/lexical equivalent that targets that layer.

Tamper stacks can invalidate syntax, alter signatures, hide the real boundary, and create irreproducible findings. Record order because tampers compose non-commutatively.

## Second-order workflow

Document:

seed state -> write input -> storage identifier -> trigger query -> observation -> reset

Common missed locations:

- profile fields later used by admin search;
- imported CSV/JSON data used by reporting;
- job names/tags used by worker queries;
- OAuth/SAML claims mapped into local records;
- webhook fields consumed by analytics;
- stored filters/sort expressions;
- audit/event data queried by dashboards.

## False-negative checklist

- wrong occurrence of a repeated parameter;
- canonical request not preserved;
- injection reachable only under another role/tenant/state;
- DBMS incorrectly forced;
- query context unsupported by selected techniques;
- safe character filter changes by content type;
- blind result hidden by cache or asynchronous response;
- CSRF/session rotation;
- second-order trigger omitted;
- target code patched behind an unchanged route;
- WAF blocks scanner signature while manual minimal payload works;
- sqlmap session cache reuses stale conclusions-use a fresh output directory when the request semantics change.
