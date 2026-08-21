---
name: analyze-api-contract-coverage
description: Deterministically compare OpenAPI JSON operations with implementation and observation inventories to expose undocumented, unimplemented, unexercised, and security-declaration coverage gaps. Use for offline API evidence reconciliation.
metadata:
  domain: application-security
  subdomain: api-contract-evidence
  triggers:
    - analyze API contract coverage
    - OpenAPI route coverage
    - compare observed operations to specification
    - find undocumented API endpoints
    - reconcile API evidence
  tags:
    - API
    - OpenAPI
    - coverage
    - evidence
    - offline-analysis
  frameworks:
    nist_csf:
      - ID.AM
---

# Analyze API Contract Coverage

Build a reproducible operation ledger from OpenAPI JSON and compare it with normalized implementation and observation inventories. Coverage is evidence of reconciliation, not proof that an operation is secure or reachable.

Stage [scripts/analyze_api_contract_coverage.py](scripts/analyze_api_contract_coverage.py), its [manifest](scripts/manifest.json), the [input schema](assets/api-contract-coverage-input.schema.json), and the [example](assets/api-contract-coverage-input.example.json). The analyzer is offline, reads only confined regular JSON files, starts no child process, and writes deterministic bounded evidence under the [output schema](assets/api-contract-coverage-evidence.schema.json).

Read [coverage-method.md](references/coverage-method.md) before interpreting unmatched operations or security declarations. Convert YAML to JSON with an already-authorized offline tool before staging; do not let format conversion fetch remote references.

## Interpret the ledger

- `undocumented_implementation` identifies registered operations absent from the selected contract set.
- `unimplemented_contract` identifies declared operations absent from the implementation inventory.
- `unexercised_contract` identifies declared operations absent from observation evidence.
- `explicitly_anonymous` identifies operations whose effective OpenAPI security is an empty requirement; validate intent in code.

Normalize aliases and gateway rewrites before treating a difference as drift. Escalate to `audit-api-contract-implementation` for executable enforcement and to protocol specialists for gRPC or SOAP behavior.
