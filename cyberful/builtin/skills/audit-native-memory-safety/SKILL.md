---
name: audit-native-memory-safety
description: Audit C, C++, unsafe Rust, native extensions, parsers, codecs, FFI boundaries, and systems code for memory corruption and low-level exploitation risk. Use for buffer overflows, out-of-bounds access, use-after-free, double free, integer overflow, format strings, uninitialized memory, type confusion, race-induced corruption, unsafe deserialization, binary parsing, compiler hardening, sanitizers, and fuzzing strategy.
---

# Audit Native Memory Safety

## Map Untrusted Bytes to Memory Operations

Inventory network protocols, files, IPC, device input, shared memory, environment, plugins, foreign calls, and privileged configuration. Trace length, offset, count, stride, allocation size, ownership, lifetime, type, and synchronization from parse to use.

Prioritize parsers and state machines reachable before authentication, code running with elevated identity, complex binary formats, custom allocators, unsafe FFI, and operations where attacker-controlled arithmetic determines memory layout.

Read [memory-unsafe-catalog.md](references/memory-unsafe-catalog.md) for review patterns. Read [native-toolchain-hardening.md](references/native-toolchain-hardening.md) for validation and mitigation.

## Establish Proof Obligations

For each memory operation, prove:

- the object is alive and uniquely or correctly shared;
- offset and length arithmetic cannot wrap;
- the complete range lies within the actual allocation;
- source and destination overlap semantics are correct;
- terminators and element sizes are included;
- signedness and width conversions preserve bounds;
- type, alignment, and initialization are valid;
- concurrent mutation cannot invalidate the proof.

Do not treat a nearby bounds check as sufficient. Trace whether it dominates the operation and uses the same canonical values.

## Review Ownership and State

Draw allocation, alias, transfer, callback, cancellation, error, and free transitions. Include exception or long-jump paths, reference cycles, weak references, async completion, reentrancy, and foreign ownership conventions.

Look for cleanup that runs twice, callbacks after teardown, container mutation invalidating pointers, and handles reused with stale type or generation.

## Validate With Focused Instrumentation

Use compiler warnings, static analysis, sanitizers, fuzzing, differential parsers, assertions, and minimized reproducers. Select sanitizers and harnesses for the suspected property; broad random fuzzing without the right state, dictionary, or oracle leaves deep logic untouched.

## Report Exploit-Relevant Conditions

State controlled field, arithmetic or lifetime failure, invalid memory operation, allocator and platform context, reachable state, mitigations present, and observed consequence. Separate crash-only evidence, disclosure, write primitive, control-flow influence, and likely exploitability.
