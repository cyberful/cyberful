---
name: test-deserialization-object-binding
description: Test native or language object reconstruction, polymorphic type selection, gadget reachability, schema bypass, mass object binding, and unsafe serializer configuration in authorized applications or disposable loopback labs. Use when untrusted bytes or fields can select types, instantiate objects, invoke callbacks, mutate privileged properties, or cross trust boundaries during decoding.
metadata:
  domain: application-security
  subdomain: deserialization-object-binding
  triggers:
    - unsafe deserialization
    - polymorphic type binding
    - deserialization gadget chain
    - object binding security
    - serializer configuration audit
    - type discriminator injection
  tags:
    - deserialization
    - object-binding
    - polymorphism
    - gadget-chain
    - schema-validation
    - parser
  frameworks:
    mitre_attack:
      - T1190
      - T1203
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test Deserialization and Object Binding

Prove the reconstruction boundary: format, parser, configuration, permitted types, constructor or callback behavior, property binding, post-load hooks, and the authority of the resulting object. A parser exception or library version alone is not a vulnerability.

## Trace reachability

Identify attacker-controlled sources, transport encodings, decode order, schema validation, type discriminators, allowlists, binder configuration, object factories, constructors, setters, magic methods, callbacks, and downstream effects. Read [references/reconstruction-proof.md](references/reconstruction-proof.md).

Distinguish data-only decoding, object binding, polymorphic reconstruction, and executable gadget reachability. For broad file flows, first use `trace-file-processing-pipelines`.

## Validate in a bounded lab

Use harmless marker fixtures and a disposable loopback harness. Start with type or property selection, then prove a non-destructive observable callback or state change. Do not use production gadget chains, outbound callbacks, persistence, or destructive effects.

Use [scripts/run_deserialization_harness.py](scripts/run_deserialization_harness.py) only against an explicitly allowed loopback origin. The runner sends bounded fixtures with fixed curl, preserves bounded secret-redacted responses, and makes no exploitability decision.

## Confirmation standard

Report format and parser, reachable type or property, configuration, full source-to-reconstruction path, safe marker effect, execution identity, sandbox boundary, matched data-only control, and affected authority.

