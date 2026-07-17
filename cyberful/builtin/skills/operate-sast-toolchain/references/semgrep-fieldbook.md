# Semgrep Fieldbook

## Pattern design

Prefer semantic anchors over large copied blocks:

- metavariables for identities that must remain equal;
- pattern-either for genuine syntax variants;
- pattern-inside/outside for structural context;
- metavariable-pattern/regex/comparison for bounded value constraints;
- focus-metavariable for useful result locations;
- taint mode for flows rather than deeply nested structural patterns.

Avoid regex when the language parser can express the same property.

## Taint-model precision

Define:

- sources at the earliest attacker/user/tenant-controlled boundary;
- sinks at the security-sensitive operation, not a generic helper;
- propagators for builders, containers, return values, callbacks, field writes, and fluent APIs;
- sanitizers only when they make the value safe for that exact sink/context;
- side-effect sanitizers carefully; an in-place validation may reject rather than transform.

Authentication is not a sanitizer for authorization. Escaping for HTML is not a sanitizer for SQL, shell, URL, or template contexts.

## High-yield custom rules

- privileged route/handler lacking the project authorization decorator/middleware;
- tenant-scoped query receiving a client tenant ID after authenticated tenant extraction;
- parser or template engine initialized with an unsafe option;
- outbound URL allowlist check separated from the actual resolved/redirected request;
- secret-bearing value passed to logs, metrics, URLs, exceptions, or client state;
- cryptographic verification result ignored or fail-open exception handling;
- unsafe deserialization wrapper variants;
- temporary file creation followed by path re-open;
- CI workflow consuming untrusted PR data in privileged shell/template contexts;
- security control call whose result is unused or inverted;
- framework method override that bypasses a base-class check.

## Differential rule testing

Change one property per fixture:

- direct versus wrapper call;
- same-file versus cross-file;
- scalar versus collection/field;
- sync versus async/callback;
- accepted versus rejected validation;
- constant versus user input;
- trusted server identity versus client identity;
- correct versus wrong sanitizer context.

This exposes where the rule model diverges from the security model.

## False-positive signatures

- dead/test/example/generated code;
- constant construction;
- enforced wrapper not modeled;
- unreachable branch under production build flags;
- type refinement or schema guarantee;
- safe API overload;
- trusted administrative maintenance path with separate boundary;
- duplicate downstream match of one root cause.

Verify rather than assume each signature.

## False-negative signatures

- reflection, dynamic import, dependency injection;
- alias/re-export and fluent builders;
- template-generated routes/models;
- persistence-mediated second-order flow;
- message/event consumer in another service;
- native/FFI boundary;
- custom encoding or serialization;
- control encoded as data/configuration;
- unsupported parser/version;
- file skipped by ignore, size, timeout, or parse failure.

## Competitive workflow

After confirming one bug:

1. express the root cause as an invariant;
2. locate all policy owners and enforcement APIs;
3. write one narrow high-confidence rule;
4. add propagators/wrappers from repository evidence;
5. run repository-wide;
6. cluster by root cause and reachability;
7. convert confirmed variants into regression fixtures;
8. keep an intentionally broad research rule separate from the gating rule.
