# Secret Propagation Method

## Prepare evidence

Create fingerprints at the trusted collection boundary. Each snapshot must be a bounded JSON artifact whose capture time and system are independently attributable. Do not include raw secret values in the analyzer request.

## Interpret results

- `allowed` means the artifact and pointer match an explicit allowlist prefix; it does not prove storage protection.
- `unexpected` means a fingerprint appeared outside that placement contract.
- Multiple occurrences can reflect templating, replication, logging, caching, or retained history; preserve snapshot time and system.
- Absence after rotation is meaningful only when the snapshot covers every expected store and representation.

Escalate a fingerprint occurrence to `audit-secrets-management` for issuance, storage, rotation, or revocation controls. Use this skill to establish where copies propagated and whether cleanup evidence is complete.
