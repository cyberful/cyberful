# Fuzzing Fieldbook

## Harness quality tests

- Feed valid production samples and confirm the intended deep function runs.
- Feed adjacent invalid samples and identify their reject stage.
- Run one input repeatedly and require stable coverage.
- Assert state reset by alternating two seeds with incompatible states.
- Check for file descriptors, threads, memory, temp files, and global caches accumulating.
- Compare harness behavior with the production entry point for the same input.

## Plateau diagnostics

- **Magic/checksum gate:** dictionary, comparison tracing, CmpLog, or structure-aware mutation.
- **Length/dependency gate:** custom mutator that repairs dependent fields after mutation.
- **State-machine gate:** sequence input format, persistent state snapshot, or separate harness per reachable state.
- **Slow seed domination:** corpus minimization by execution time and coverage, then isolate pathological paths.
- **Coverage instability:** remove randomness/concurrency, pin environment, initialize once safely, reset per iteration.
- **Parser-only coverage:** preserve downstream consumers and invariants after parse success.
- **JNI/native blind area:** build native library with compatible sanitizer/coverage and preserve symbols.

## Engine-specific leverage

### AFL++

Use persistent mode only if reset is demonstrably complete. Use CmpLog for opaque comparisons, parallel main/secondary instances with distinct strategies, afl-cmin for coverage-preserving corpus minimization, and FRIDA/QEMU modes when recompilation is unavailable. Binary-only coverage quality differs from compile-time instrumentation; record the mode.

### libFuzzer

Use value profiling for comparison-heavy code, dictionaries and custom mutators for structured formats, focused functions only for exploration rather than final coverage claims, and merge/minimize operations to maintain a compact regression corpus.

### Jazzer

Place the target at a production JVM boundary; use FuzzedDataProvider for typed sequences only when it preserves real framing semantics. Evaluate hooks for command, SQL, LDAP, path, expression, deserialization, and similar sinks as bug detectors that still require path and controllability analysis. Include JNI crashes in native triage.

## Crash classes often lost in deduplication

Same top frame can hide distinct integer overflow, lifetime, bounds, race, or parser-state causes. Different top frames can share one corrupted-length or ownership root cause. Deduplicate using the earliest invalid invariant, not only stack hashes.

## False-negative traps

Invalid-only corpus, unstable coverage, incomplete reset, sanitizer-disabled dependencies, forkserver incompatibility, swallowed JVM exceptions, target timeouts, excessive maximum input, missing dictionaries, release-only paths, architecture-specific code, locale/encoding differences, and harness bypass of production decoding.
