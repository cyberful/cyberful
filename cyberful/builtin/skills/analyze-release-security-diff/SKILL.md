---
name: analyze-release-security-diff
description: Deterministically compare bounded offline release manifests to identify artifact, digest, provenance, signer, permission, dependency, and deployment-input changes that alter the reviewed security boundary.
metadata:
  domain: software-supply-chain
  subdomain: release-security-diff
  triggers:
    - analyze release security diff
    - compare artifact manifests
    - release provenance delta
    - deployment input change
    - signer permission diff
  tags:
    - release
    - artifacts
    - provenance
    - signatures
    - dependencies
    - offline-analysis
  frameworks:
    mitre_attack:
      - T1195
    nist_csf:
      - GV.SC-09
      - PR.PS-06
---

# Analyze Release Security Diff

Compare immutable artifact identities and their trust evidence, not version labels alone. Keep source revision, build invocation, provenance, signer, dependency lock, deployment permissions, and destination binding distinct.

Stage [scripts/analyze_release_security_diff.py](scripts/analyze_release_security_diff.py), its [manifest](scripts/manifest.json), and the [example](assets/release-security-diff-input.example.json). The analyzer is offline, reads two confined regular JSON manifests, starts no child process, and writes deterministic bounded delta evidence under the [output schema](assets/release-security-diff-evidence.schema.json).

Read [release-diff-method.md](references/release-diff-method.md) before classifying a changed artifact. A changed digest is evidence of different bytes, not evidence of compromise.

## Interpret the delta

Separate additions, removals, content changes, provenance changes, signer changes, permission changes, and dependency changes. Escalate reachable trust breaks to `audit-build-release-pipelines` or `audit-software-supply-chain`; preserve unresolved collection gaps instead of filling them by inference.
