---
name: operate-native-fuzzing
description: Operate AFL++, libFuzzer with Clang sanitizers, and Jazzer for advanced coverage-guided native and JVM fuzzing. Use when designing harnesses, constructing and minimizing corpora, diagnosing coverage plateaus, selecting sanitizers or instrumentation modes, fuzzing parsers and state machines, deduplicating crashes, or turning audit hypotheses into deterministic regression cases.
---

# Operate Native Fuzzing

The harness defines the reachable security model. Optimize semantic depth and reproducibility before execution speed; a fast harness that never crosses initialization, checksum, or parser state boundaries produces false assurance efficiently.

## Write the harness contract

Document target function and build, input framing, state reset, environment, allocator, thread model, timeout, maximum input, expected rejects, external side effects, and invariants. Remove network, clock, randomness, process-global caches, and nondeterministic concurrency unless they are the property under test.

For structured formats, expose bytes at the earliest production parser boundary while retaining real downstream validation and object use. Do not replace the parser with a fuzzer-specific decoder that cannot represent production bugs.

## Choose the engine deliberately

- Use libFuzzer for in-process C/C++ targets with tight sanitizer and coverage integration.
- Use AFL++ when fork/persistent modes, binary-only modes, distributed queues, custom mutators, CmpLog, or file/process harnesses fit better.
- Use Jazzer for JVM targets, Java/Kotlin parsers, and sanitizer hooks for injection/deserialization-style behavior.

Read [references/fuzzing-fieldbook.md](references/fuzzing-fieldbook.md) for harness diagnostics and plateau recovery.

## Build the instrumentation matrix

Create reproducible debug symbols and separate ASan/UBSan, MSan where the whole dependency graph supports it, and coverage-focused builds. Treat sanitizer incompatibilities and optimized release-only behavior explicitly. For native code reached through JVM/JNI, fuzz and symbolize both sides.

Compile AFL++ targets with afl-clang-fast or afl-clang-fast++, and libFuzzer targets with Clang plus fuzzer and sanitizer flags. Keep raw compiler invocations in evidence.

## Seed for grammar and state

Start with valid minimal examples spanning format versions, optional sections, boundary sizes, encodings, compression, nested structures, and semantic states. Minimize only after confirming that rare states and coverage are retained. Add dictionaries for tokens; use custom mutators when checksums, length fields, or dependent structures block progress.

## Diagnose plateaus

Measure executions, edge/feature growth, corpus growth, reject-stage distribution, input length, stability, and time per seed. Instrument milestones inside the harness or target. Apply comparison tracing/CmpLog, value profiles, dictionaries, corpus surgery, targeted seeds, state snapshots, or a better boundary based on the blocking predicate.

## Triage and prove crashes

Reproduce outside the fuzzer with the exact build and environment; minimize while preserving the same root cause; symbolize; identify first invalid state rather than final crash; deduplicate by causal frame/data invariant; test sanitizer-independent behavior where relevant; and create a regression case.

## Deliver

Preserve source/build hash, compiler, flags, harness, corpus provenance, engine configuration, coverage and stability metrics, crash input, minimized reproducer, sanitizer log, root-cause trace, and untested state space. "No crashes" is only meaningful with the harness and coverage evidence attached.
