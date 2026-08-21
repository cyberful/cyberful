---
name: trace-secret-propagation
description: Trace secret fingerprints through bounded offline configuration, deployment, log, and runtime snapshots to identify allowed placement, unexpected propagation, stale copies, and cleanup gaps without emitting secret values.
metadata:
  domain: cloud-security
  subdomain: secret-propagation
  triggers:
    - trace secret propagation
    - find credential copies
    - secret lifecycle evidence
    - configuration secret leakage
    - verify secret cleanup
  tags:
    - secrets
    - credentials
    - propagation
    - fingerprints
    - offline-analysis
    - lifecycle
  frameworks:
    mitre_attack:
      - T1552
    nist_csf:
      - PR.AA-01
      - PR.DS-01
---

# Trace Secret Propagation

Trace digests, not plaintext. Start from engagement-supplied SHA-256 fingerprints and bounded JSON snapshots; never copy a discovered credential into the request or evidence artifact.

Stage [scripts/trace_secret_propagation.py](scripts/trace_secret_propagation.py), its [manifest](scripts/manifest.json), and the [example](assets/secret-propagation-input.example.json). The analyzer is offline, opens only confined regular JSON files, starts no child process, and emits deterministic occurrence and lifecycle evidence under the [output schema](assets/secret-propagation-evidence.schema.json).

Read [secret-propagation-method.md](references/secret-propagation-method.md) before interpreting an occurrence or absence. A missing digest can mean transformation or incomplete evidence, not successful cleanup.

## Interpret the trace

Compare every occurrence against the marker's allowed artifact and JSON-pointer prefixes. Correlate first/last observations, rotation epoch, deployment version, revocation, and cleanup evidence. Report plaintext exposure only when the source artifact itself establishes it; the helper intentionally records only digests and pointers.
