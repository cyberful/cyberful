---
name: operate-sqlmap
description: Use sqlmap to confirm and characterize suspected SQL injection with faithful requests and bounded evidence. Trigger for URL, form, JSON, XML, header, cookie, multipart, GraphQL-variable, authenticated, stored/second-order, or custom request-file injection hypotheses after manual differential evidence or code tracing identifies a plausible SQL dataflow.
---

# Operate SQLMap

Sqlmap is a hypothesis amplifier. Start from a faithful known-good request and preserve the application state, encoding, and parameter occurrence that made the candidate observable.

## Prepare a canonical request

Prefer a raw request file when the target uses authentication, JSON/XML/multipart bodies, duplicate parameters, nonstandard methods, CSRF tokens, virtual hosts, or fragile headers. Remove transport artifacts that should be regenerated, but retain semantically required headers and cookies.

Identify:

- exact injection marker/parameter occurrence;
- baseline response and stable comparison signal;
- authentication and tenant context;
- prerequisite workflow/state;
- replay safety and idempotency;
- suspected DBMS/query context from code or errors.

Read [references/sqlmap-fieldbook.md](references/sqlmap-fieldbook.md) for detection tuning, second-order handling, tamper selection, and false-negative analysis.

## Escalate detection deliberately

1. Run a low-noise detection pass against one parameter.
2. Pin DBMS only when evidence supports it.
3. Select techniques from the suspected query shape: boolean, error, union, stacked, time.
4. Increase level only for additional parameter locations/headers that matter.
5. Increase risk only when the generated predicates are appropriate for the operation.
6. Use explicit prefix/suffix or boundary tuning when source/query evidence shows the syntactic context.
7. Inspect payload and comparison logs before adding tampers.

Do not stack multiple tampers speculatively. Each tamper should correspond to an observed canonicalization, filter, parser, or intermediary transformation.

## Preserve request fidelity

Control redirects, cookies, CSRF refresh, randomization parameters, null connection, compression, keep-alive, proxying, and safe-frequency checks explicitly. A working browser request can fail in sqlmap because:

- a token must be refreshed;
- duplicated keys have precedence;
- content type selects a different binder;
- the application signs body bytes;
- a WAF/session cookie changes the path;
- redirects cross host or method boundaries;
- the vulnerable value is consumed only after a prior state transition.

Use traffic capture and verbosity to compare the generated request with the canonical request byte-for-byte where necessary.

## Establish the minimum proof

Detection requires a repeatable true/false, error, union, stacked, or time discriminator tied to the parameter. Characterization may include DBMS family, current database/user, and effective privilege only when needed for impact. Broad enumeration is not a prerequisite for confirmation.

For time-based results, collect multiple controls, randomized order, and latency distribution. One slow response is not confirmation.

For stored/second-order candidates, separate write request, persistence key, trigger request, observation point, and cleanup. Ensure sqlmap is comparing the trigger response, not the storage response.

## Reproduce independently

Extract the decisive request pair or minimal sequence from sqlmap logs and replay it manually. A confirmed result links:

controlled input -> query-context discriminator -> repeatable application/DB effect

Report sqlmap's result as supporting evidence, not the entire causal explanation.

## Handoff

Preserve raw request template, sqlmap version, exact argv, output/session directory, parameter marker, techniques, payload pair, timing samples, DBMS evidence, application state, rejected hypotheses, and independent replay. Separate confirmed injection from privilege/impact that was not tested.
