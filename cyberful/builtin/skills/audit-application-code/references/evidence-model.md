# Code-Audit Evidence Model

## Required finding record

Record:

- stable finding identifier and weakness class;
- affected commit, component, configuration, and deployment assumptions;
- file and precise line for source, missing control, sink, and relevant wrappers;
- attacker-controlled origin and required capability;
- complete call/data/control path;
- normalization, validation, authorization, and sanitization encountered;
- why each control does not dominate the vulnerable path;
- security-sensitive operation and observed or logically necessary effect;
- alternate paths and systemic scope;
- confidence, unresolved assumptions, severity rationale, remediation, and regression test.

## Proof standards

Use one or more:

- executable test that fails before remediation and passes after it;
- minimal local PoC using synthetic data and no external effect;
- framework- or language-defined semantic proof with all runtime assumptions cited;
- deployment configuration demonstrating reachability and authority;
- differential trace showing the missing decision;
- static path proof supported by callers, types, build graph, and configuration.

Scanner output, a sink search, or a vulnerable dependency version alone is a candidate.

## Severity discipline

Separate:

- weakness severity from reachable product impact;
- current configuration from possible configuration;
- local process effect from cross-boundary compromise;
- tester-owned demonstration from access to other users or tenants;
- confidentiality, integrity, availability, financial, privacy, compliance, and supply-chain consequences.

State the minimum attacker capability and the maximum evidenced impact. Do not score speculative chains as proven.
