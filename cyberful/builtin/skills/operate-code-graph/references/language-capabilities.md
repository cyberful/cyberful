# Code Graph Language Capability Contract

## Current runtime contract

The shipped registry recognizes the families below through repository-owned deterministic semantic-lexer or
declarative profiles. Program profiles currently provide exact lexical parsing and heuristic symbol, control-
flow, call, def-use, alias, summary, security, and cross-language facts. Declarative profiles provide structural
topology, dependency, trust, and configuration facts and report program-only capabilities as unsupported.

No shipped profile is a compiler-grade language frontend, and the manifest explicitly records
`grammarWasm: false`. Recognition, an extension match, or a successful lexical scan does not make a language
first-class. Every engagement must preserve the capability levels, diagnostics, unresolved edges, truncation,
and source verification needed for the indexed snapshot.

## First-class promotion gate

An adapter is first-class only when the coverage result demonstrates all applicable capabilities for the
indexed snapshot:

1. tolerant parsing with stable source locations;
2. symbol declaration/reference and import/module resolution;
3. control-flow graph;
4. call or domain-equivalent interconnection graph;
5. def-use plus applicable alias, ownership, field, memory, signal, or register relationships;
6. interprocedural or intermodule summaries with recursion/fixed-point handling;
7. source, sink, sanitizer, guard, trust-boundary, and privileged-operation semantics;
8. cross-language/schema/configuration edge extraction;
9. incremental invalidation of dependents, callers, implementations, and consumers;
10. native security rules with positive and negative evidence fixtures.

Map the runtime's `exact`, `heuristic`, `structural`, and `unsupported` results to this gate without upgrading
them. A family is first-class only if a future adapter demonstrates every required capability at full semantic
fidelity for the indexed snapshot. The current heuristic profiles do not pass that gate. Never infer support
from a grammar, filename, or registry entry being present.

## Registered families and promotion targets

The lists below define detection coverage and the intended first-class promotion targets; they are not a claim
that compiler-grade adapters, native rule packs, ABI/bytecode mapping, or domain simulators ship today.

Application detection and promotion targets include:

- JavaScript, TypeScript, JSX, and TSX;
- Python;
- Java, Kotlin, and Scala;
- C# and F#;
- Go, Swift, PHP, Ruby, Lua, Erlang, and Elixir;
- Bash and procedural SQL.

Systems detection and promotion targets include:

- C, C++, Objective-C, and Objective-C++;
- Rust, Zig, and Ada/SPARK;
- CUDA;
- WebAssembly and WAT;
- x86, ARM, and RISC-V assembly.

Cryptography and Web3 detection and promotion targets include:

- ordinary cryptographic implementations in every application/systems family above;
- Solidity, Vyper, Move, Cairo, Circom, Noir, Sway, Clarity, and Haskell;
- contract ABI, bytecode/source maps, storage layout, proxy/upgrade, and host-chain boundaries.

Robotics and control detection and promotion targets include:

- MATLAB and IEC 61131-3 Structured Text;
- Verilog, SystemVerilog, and VHDL;
- ROS 1/2 package, launch, topic, service, and action relationships;
- DDS/SROS policy; URDF, SDF, and Xacro models;
- firmware, device-tree, linker-script, bus, MMIO, DMA, sensor, actuator, and update boundaries.

## Domain-equivalent semantics

For a future full HDL adapter, replace ordinary calls/variables with module instances, processes, clock/reset
domains, signals, ports, drivers, and sinks. Preserve intermodule propagation and slicing.

For a future full PLC adapter, model programs, function blocks, tasks/cycles, variables, fieldbus inputs, safety
interlocks, and actuator writes. Preserve state and scan-cycle dependencies.

For a future full assembly adapter, model procedures/labels, branch flow, registers, flags, stack, memory
regions, calls/returns, interrupts, and privileged instructions. Preserve conservative clobber and alias
relationships.

Declarative artifacts use a topology, dependency, trust, and configuration graph rather than fake program
dataflow. This includes Protobuf/OpenAPI, CMake/Make/Meson/Bazel, Dockerfile, Terraform/HCL, Kubernetes, CI/CD,
YAML/JSON/TOML/XML, manifests, and lockfiles.

## Native security-pack promotion targets

A future first-class adapter must identify which domain packs ran and their rule version. Until such a pack is
present, report heuristic security semantics and verify every candidate against source or reproducible evidence:

- web/application: injection, deserialization, SSRF, traversal, XSS, authentication, authorization, secrets,
  reflection, races, and resource amplification;
- native/systems: bounds, lifetime, use-after-free, double-free, integer/pointer errors, format strings, FFI,
  concurrency, unsafe memory, and hardening;
- cryptography: randomness/nonces, key lifecycle, signature verification/malleability, primitive misuse,
  constant-time behavior, zeroization, serialization, and consensus determinism;
- smart contracts: reentrancy, authorization, external-call effects, storage/proxy safety, oracle/MEV,
  accounting, and invariants;
- robotics/firmware: sensor-to-actuator influence, ROS/DDS authorization, parameter injection, update/secure
  boot, debug interfaces, MMIO/DMA, real-time denial of service, PLC writes, and hardware trust boundaries.

## Grammar provenance gate

The current runtime ships no grammar WASM and must not imply otherwise. If a grammar-backed adapter is added in
the future, every loaded grammar must resolve to an embedded, version-pinned manifest entry containing origin,
immutable revision, license, and SHA-256. Record missing or mismatched entries as a hard adapter failure. Never
download, compile, or replace a grammar during an engagement.
