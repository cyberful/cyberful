---
name: trace-identity-propagation
description: Reconstruct how principal, actor, issuer, audience, assurance, scopes, and delegated authority change across requests, tokens, services, queues, and stored artifacts.
metadata:
  domain: identity-security
  subdomain: identity-propagation
  triggers:
    - identity propagation trace
    - principal context flow
    - delegated identity chain
    - token claim transformation
    - actor subject confusion
    - authentication context propagation
  tags:
    - identity
    - claims
    - delegation
    - token-exchange
    - dataflow
    - causal-trace
  frameworks:
    mitre_attack:
      - T1528
      - T1550.001
    nist_csf:
      - PR.AA-03
      - PR.AA-04
      - PR.AA-05
---

# Trace Identity Propagation

Reconstruct identity as a sequence of evidence-backed transformations. Keep actor, subject, client, service, tenant, issuer, audience, assurance, credential, and delegated authority separate at every boundary.

## Assemble the trace

Read [references/identity-propagation-method.md](references/identity-propagation-method.md). Collect controlled request and response records, token summaries, gateway logs, service logs, queue envelopes, policy inputs, and storage effects. Hash raw artifacts and record only the minimum non-secret excerpt needed to locate each event.

Order events by a stable trace-specific sequence, not by wall-clock time alone. Mark gaps, fan-out, retries, asynchronous continuations, and points where an end-user identity becomes a workload identity or vice versa.

## Normalize offline evidence

Use [scripts/trace_identity_propagation.py](scripts/trace_identity_propagation.py) for a deterministic offline delta ledger. Copy [assets/identity-propagation.example.json](assets/identity-propagation.example.json), retain [assets/identity-propagation.schema.json](assets/identity-propagation.schema.json), and interpret output against [assets/identity-propagation-evidence.schema.json](assets/identity-propagation-evidence.schema.json).

The script reads no environment secrets, opens no network connection, invokes no child process, enforces a global monotonic deadline, and writes bounded raw evidence atomically. It identifies changed fields; it does not decide whether a change is authorized or vulnerable.

## Locate the failed contract

Compare every transformation with the receiving component's trust contract. Determine whether issuer, subject namespace, audience, tenant, scopes, assurance, actor, delegation chain, or credential binding is dropped, widened, synthesized, or accepted from the wrong authority.

Report the last trustworthy event, first unsupported transformation, downstream decision, durable effect, and corroborating artifact hashes. Route tenant-specific divergence to `trace-tenant-context-propagation` and enforcement gaps to `audit-access-policy-enforcement` or `test-authorization-boundaries`.
