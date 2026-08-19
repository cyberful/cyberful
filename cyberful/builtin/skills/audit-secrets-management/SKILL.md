---
name: audit-secrets-management
description: Audit secret issuance, storage, delivery, use, rotation, revocation, replication, logging, and break-glass controls across application and cloud systems. Use for vault, KMS-backed secret store, workload secret, or credential-lifecycle review.
metadata:
  domain: identity-security
  subdomain: secrets-management
  triggers:
    - secrets management audit
    - secret rotation review
    - vault policy audit
    - credential delivery security
    - secret lifecycle assessment
    - break glass credential review
  tags:
    - secrets
    - credential-lifecycle
    - vault
    - rotation
    - revocation
    - workload-delivery
  frameworks:
    nist_csf:
      - PR.AA-01
      - PR.DS-01
---

# Audit Secrets Management

Treat every secret as a capability with an issuer, subject, audience, scope, lifetime, delivery path, storage locations, observers, and revocation behavior. Do not reduce the audit to encryption-at-rest or scanner matches.

## Trace the lifecycle

Read [references/secret-lifecycle-method.md](references/secret-lifecycle-method.md). Populate [assets/secret-control-ledger.example.json](assets/secret-control-ledger.example.json) using [assets/secret-control-ledger.schema.json](assets/secret-control-ledger.schema.json). Use identifiers and hashes, never secret values. Record issuance authority, consumers, delivery mechanism, storage/replication, rotation owner, revocation propagation, audit evidence, and break-glass path.

Inspect configuration, access policies, workload identities, templates, logs, backups, caches, CI variables, runtime mounts, environment delivery, crash artifacts, support tooling, and operator workflows. Distinguish a reference to a secret from possession of its value and possession from accepted authority at the relying service.

## Confirm exposure or authority

Report exposure only when an unintended actor can retrieve or observe secret material; report authority only when the credential is accepted for a protected effect. Include lifetime, audience, scope, replay conditions, revocation result, affected replicas, and rotation/restoration requirements without reproducing the secret.
