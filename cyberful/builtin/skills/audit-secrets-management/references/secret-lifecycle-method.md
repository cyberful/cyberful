# Secret lifecycle method

## Capability tuple

Record `secret identifier/hash | issuer | subject | audience | scope | issuance path | delivery path | stores/replicas | observers | lifetime | rotation | revocation | relying service`. Keep secret values outside notes, commands, fixtures, and evidence.

## Lifecycle checks

- Issuance requires an intended principal and binds the narrowest usable audience and scope.
- Delivery prevents unintended logs, arguments, images, shared volumes, templates, and environment inheritance.
- Storage and replication have explicit owners, access policies, encryption context, backup behavior, and deletion semantics.
- Consumers avoid copying into secondary stores and fail closed when material is missing, expired, or revoked.
- Rotation updates producers and consumers without a long dual-validity window or orphaned replicas.
- Revocation propagates to caches, sessions, derived tokens, build artifacts, and break-glass copies within a known bound.
- Audit evidence identifies access and administration without recording values.

Classify findings as material exposure, over-broad retrieval, over-broad accepted authority, stale validity, untracked replication, or operational recovery gap.
