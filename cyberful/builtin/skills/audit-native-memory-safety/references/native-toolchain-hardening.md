# Native Validation and Hardening

## Harness Design

Drive the narrowest parser or state machine below transport and authentication when possible. Preserve production initialization, allocator, feature flags, dictionaries, and corpus structure. Assert semantic invariants in addition to crash detection.

Use structure-aware generation, comparison with a second implementation, stateful sequences, fault injection, and coverage analysis. Seed boundary values around lengths, counts, recursion, encodings, and lifecycle transitions.

## Sanitizers and Analysis

Select complementary checks:

- address and leak sanitizers for spatial, temporal, and leak defects;
- undefined-behavior checks for arithmetic, shift, alignment, and invalid type operations;
- memory-initialization checks for uninitialized reads;
- thread or race detectors for synchronization defects;
- control-flow and shadow-stack protections where supported;
- compiler warnings and static analyzers configured for the actual language dialect.

Run optimized and debug-representative builds when behavior differs. Sanitizers change timing and layout; absence of a crash is not proof of safety.

## Build Hardening

Verify stack protection, non-executable memory, position independence and ASLR compatibility, relocation protection, fortified library calls, control-flow integrity where feasible, safe exception and unwind behavior, symbol handling, and removal of obsolete dangerous APIs.

Hardening raises exploitation cost but does not close the memory-safety defect.

## Triage Signals

Minimize while preserving the same fault address and path. Record sanitizer class, allocation and free stacks, controlled bytes, heap layout dependencies, architecture, compiler, optimization, and mitigations.

## Deep Audit Hints

- Compare behavior with allocator quarantine disabled and enabled to expose timing-dependent UAF.
- Test big-endian or 32-bit assumptions through targeted analysis even if the production host is 64-bit little-endian.
- Review generated bindings and build flags; security annotations and sanitizer coverage can disappear across a language boundary.
- Examine signal handlers, forked children, and cancellation cleanup for async-safety and double cleanup.
- Treat parser differentials as potential security issues when validation and execution use different implementations.
