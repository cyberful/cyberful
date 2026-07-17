# Language and Runtime Routing

Load only the detected sections. Treat these as search seeds, not vulnerability verdicts.

## JavaScript, TypeScript, Node.js, and Bun

Trace dynamic evaluation, child processes, shell options, URL construction, filesystem resolution, archive extraction, prototype mutation, object merging, template and HTML sinks, regular expressions, JSON-to-class binding, request proxying, SSR frameworks, middleware order, trust-proxy configuration, package scripts, worker boundaries, environment inheritance, and ESM/CommonJS loading differences.

Review promise rejection, cancellation, stream backpressure, body-size limits, abort propagation, race-prone caches, server-side rendering hydration, source maps, development endpoints, and client bundle secrets.

## Python

Trace `subprocess`, shell flags, dynamic import/evaluation, pickle and YAML loaders, template environments, ORM raw expressions, path handling, archive extraction, XML parsers, URL fetchers, debug modes, object hooks, format strings, temporary files, notebook execution, dependency indexes, and unsafe deserialization across task queues.

Review async cancellation, multiprocessing environment inheritance, exception fallbacks, decorator order, framework proxy headers, CSRF exemptions, serializer field exposure, and type coercion.

## Java and JVM languages

Trace expression languages, reflection, class loading, JNDI, object serialization, XML factories, template engines, process execution, path canonicalization, archive extraction, ORM query construction, mass assignment, Spring security chains, actuator exposure, deserialization gadgets, logging lookups, and dependency scopes.

Review servlet filters, method security versus route security, transaction boundaries, reactive context propagation, thread-local identity, cache key tenant binding, and build plugins.

## .NET

Trace process starts, dynamic compilation, reflection, BinaryFormatter-like serializers, XML settings, Razor and HTML sinks, SQL APIs, path and archive handling, model binding, authorization attributes and fallback policies, data-protection key storage, forwarded headers, and unsafe native interop.

Review middleware order, endpoint metadata, claims transformation, antiforgery coverage, async disposal, cancellation, hosted services, configuration providers, and deployment secrets.

## Go

Trace `os/exec`, template package choice, SQL construction, URL and proxy behavior, filesystem joins, archive extraction, YAML/JSON decoding into permissive structures, unsafe use, cgo, plugin loading, HTTP server limits, and cryptographic randomness.

Review goroutine lifetime, channel ownership, context cancellation, shared maps, request-body closure, reverse-proxy rewriting, path cleaning, integer conversion, and error paths that continue with zero values.

## Rust

Trace `unsafe`, FFI, raw pointers, lifetime escapes through global state, command execution, path and archive handling, deserialization with untagged or permissive enums, template and SQL construction, URL fetchers, procedural macros, build scripts, and dependency features.

Review panic boundaries, integer overflow mode differences, cancellation safety, lock poisoning, `Send`/`Sync` assumptions, zeroization, secret formatting, and unsafe abstractions whose public API permits invariant violation.

## C and C++

Route to `audit-native-memory-safety`. Inventory parsers, allocators, length calculations, ownership transfers, string and format APIs, integer narrowing, concurrency, signals, privilege changes, environment and loader behavior, temporary files, cryptographic APIs, and compiler hardening.

## PHP, Ruby, and other dynamic runtimes

Trace dynamic include/load, evaluation, process APIs, template escaping modes, ORM escape hatches, mass assignment, unsafe YAML or object deserialization, filesystem wrappers, URL schemes, upload handling, session configuration, constant-time comparison, dependency hooks, and production debug behavior.

For an unfamiliar runtime, derive sources, interpreters, parsers, authority boundaries, resource lifetimes, concurrency model, package/build hooks, and framework default controls rather than guessing API semantics.
