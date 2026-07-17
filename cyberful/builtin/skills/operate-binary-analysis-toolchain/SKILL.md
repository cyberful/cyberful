---
name: operate-binary-analysis-toolchain
description: Operate Ghidra headless analysis, radare2, platform binary utilities, decompilers, and targeted dynamic evidence for advanced native and bytecode security review. Use for stripped or optimized binary triage, architecture and hardening analysis, call-graph and dataflow reconstruction, patch diffing, parser or trust-boundary review, JNI/native correlation, or resolving disagreements between decompilers and actual machine behavior.
---

# Operate Binary Analysis Toolchain

Treat decompiler output as a lossy hypothesis. Anchor conclusions in bytes, relocations, calling convention, control/data flow, and runtime evidence.

## Establish artifact identity

Record cryptographic hash, source/provenance, format, architecture/subarchitecture, endianness, ABI, load address, sections/segments, imports/exports, relocations, interpreter/runtime, signatures, debug symbols, packing, and hardening. Keep universal/fat slices and platform variants separate.

## Triage before decompiling

Map entry points, initialization/finalization, exported interfaces, IPC/network/file/parser boundaries, privilege transitions, cryptographic and verification APIs, dynamic loading, dangerous memory/process functions, error/log paths, and embedded configuration. Use strings only as cross-reference seeds.

Run Ghidra headless for reproducible imports, analysis options, scripts, and exports. Use radare2 and platform tools to independently confirm sections, functions, references, and instructions at critical sites.

Read [references/binary-analysis-fieldbook.md](references/binary-analysis-fieldbook.md) when reconstructing optimized code or patch-diffing.

## Reconstruct security invariants

For each boundary:

1. identify exact calling convention and argument ownership;
2. trace length, signedness, encoding, lifetime, and error values;
3. locate all dominating validation and authorization branches;
4. follow indirect calls, vtables, jump tables, callbacks, and dynamic imports;
5. inspect cleanup and exceptional exits;
6. verify ambiguous behavior in disassembly or a bounded runtime trace.

Search both forward from untrusted input and backward from sensitive effects.

## Account for compiler transformations

Expect inlining, tail calls, thunks, split functions, merged constants, stack-slot reuse, dead-code elimination, exception tables, link-time optimization, and control-flow flattening. Rename functions and types only with confidence annotations. Preserve raw addresses and image bases so another analyst can reproduce references.

## Diff by semantics

For patches, normalize addresses and compiler noise; compare control-flow shape, constants, call targets, bounds, validation order, error handling, and data structure layout. Trace the changed invariant outward to sibling functions and older product branches. A one-line source fix may compile into several sites, while a large binary diff may be toolchain noise.

## Deliver

Preserve hashes, loader options, analysis database/project, script versions, architecture assumptions, annotated functions, raw disassembly at decisive sites, xrefs, dynamic traces, unresolved indirect calls, and confidence. Report the earliest violated invariant and a reproducible input or state when possible.
