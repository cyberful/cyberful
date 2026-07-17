# Binary Analysis Fieldbook

## Decompiler lie patterns

- incorrect signedness or integer width;
- guessed pointer versus scalar types;
- merged stack variables across lifetimes;
- omitted overflow/carry flags that drive a branch;
- exception or cleanup edges hidden in structured output;
- tail call rendered as return;
- thunk/PLT/import wrapper mistaken for business logic;
- switch recovery losing default or sparse cases;
- vtable/interface call typed to the wrong class;
- undefined behavior simplified into misleading source-like logic.

Inspect the decisive instructions, flags, and calling convention whenever impact depends on one of these.

## Rare high-yield anchors

- parser length converted between signed/unsigned widths;
- allocation size checked before multiplication/addition but used after transformation;
- authentication result collapsed with transport or parse error;
- certificate/signature verification API return semantics inverted;
- dynamic library/plugin path built from environment or writable configuration;
- temporary file created safely then reopened by path;
- integer truncation at FFI, syscall, IPC, or serialization boundary;
- cleanup path releases an object still referenced by callback/event state;
- dispatch table entry reachable through a protocol version or feature flag omitted from UI;
- hardening present globally but absent on a loaded plugin/helper.

## Patch-diff workflow

1. Verify matching architecture, product lineage, and build provenance.
2. Identify toolchain and library-version noise.
3. Match functions using references, constants, CFG, and call neighborhoods.
4. Classify changes as validation, bounds, lifetime, privilege, cryptography, logging, or refactor.
5. Reconstruct the pre-patch violated invariant.
6. Search unchanged siblings for the same invariant.
7. Produce the smallest differential input or state.

## Dynamic confirmation

Prefer observation at the target boundary: arguments, return, errno/exception, relevant memory region, and stack. Account for ASLR/image rebasing, PIE, PAC/BTI, anti-debugging, forked children, and JIT/self-modifying code. Do not modify a production artifact merely to make analysis convenient without recording the transformation.

## False-negative traps

Wrong architecture slice, stripped imports resolved by hashes, encrypted/packed sections, runtime-generated code, dormant plugins, feature-gated functions, decompiler analysis timeout, incorrect base address, indirect-call recovery gaps, exception tables, and native code invoked only through another runtime.
