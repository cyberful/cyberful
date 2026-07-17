# Taint and Injection Proof

## Source classification

Classify direct request data, identity claims, headers, cookies, files, database content, third-party responses, environment, configuration, queue messages, logs, model output, and administrator-authored content. "Internal" is not synonymous with trusted.

## Transform classification

Record decoding, parsing, normalization, validation, sanitization, escaping, parameterization, encoding, concatenation, formatting, storage, serialization, and trust annotations. Note order and whether transforms are reversible or context-specific.

## Path completeness

Inspect aliases, wrappers, callbacks, decorators, middleware, dependency injection, virtual dispatch, generated code, background tasks, error fallbacks, retries, and alternate sinks. Prove build and configuration reachability.

## False-positive controls

Exclude constant strings, unreachable debug code, typed values that cannot alter grammar, safe builder nodes, correctly parameterized values, fixed allowlisted identifiers, and escaped values whose final context is proven. Do not assume a helper is safe from its name.

## Evidence

Prefer parsed query or AST, database or interpreter logs in a controlled environment, child-process argv, rendered DOM/context, structured log output, or a minimal regression test. If direct observation is unavailable, document the language or library semantics and every assumption required for static proof.
