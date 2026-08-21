# Identity Linking Method

## Required proof

An association requires current proof of control over every principal being joined, a tenant-aware authorization decision, an unambiguous resulting identity, and a reversible audit trail. Possession of one authenticated session does not prove authority over a second account or organization.

## Ceremony matrix

- Invitation: bind issuer, recipient, tenant, role, expiry, and single-use state.
- Link or merge: bind both authenticated principals, canonical issuer/subject pairs, ownership conflicts, and rollback.
- Provision or update: bind directory source, immutable external identifier, tenant, attribute authority, and role policy.
- Suspend or deprovision: invalidate active sessions, delegated credentials, group-derived access, cached decisions, and pending invitations.
- Re-provision: prove whether retired identifiers, tombstones, or stale mappings can restore unintended access.

Capture before/after identities, memberships, sessions, notifications, audit events, and cleanup. Use synthetic addresses and tenant fixtures controlled by the engagement.
