# Authentication Lifecycle Checks

## Registration and invitations

- prove uniqueness and ownership without trusting client-supplied verification flags;
- bind invitations to intended tenant, role, recipient, expiry, and one-time acceptance;
- prevent accepting after revocation, role change, recipient change, or existing-account collision;
- prevent pre-account takeover through unverified identifiers or automatic account merging;
- ensure administrative provisioning and bulk import preserve the same identity guarantees.

## Login and identifier handling

- normalize once and compare consistently across registration, login, recovery, federation, and audit;
- avoid account selection ambiguity across tenants and identity providers;
- require constant-work behavior where practical without treating minor timing differences as proven enumeration;
- separate credential validity from account state to avoid lockout or suspension bypass;
- check alternate clients, versions, and legacy endpoints for weaker ceremonies.

## Credential and authenticator changes

- require fresh, appropriately strong evidence before password, email, phone, passkey, MFA, recovery, or trusted-device changes;
- notify old and new channels without making notification delivery the only control;
- invalidate outstanding challenges that reference changed identity data;
- rotate or revoke affected sessions and recovery material according to risk;
- prevent a compromised session from silently replacing every recovery path.

## Account state and deprovisioning

- enforce lock, suspension, deletion, offboarding, tenant removal, and role removal across sessions, tokens, API keys, devices, background jobs, and integrations;
- define whether reactivation restores old authenticators and whether that is safe;
- prevent deleted or recycled identifiers from inheriting old authority;
- retain sufficient audit linkage without retaining unnecessary authentication secrets.

## Anti-automation and cost

Model attempts per target identity, source, device, credential pair, recovery destination, tenant, and expensive downstream action. Test distributed and low-rate abuse conceptually; do not evade controls by rotating identities or infrastructure during an authorized engagement. Verify throttling failure behavior and recovery from counter-store outages.

## Evidence record

Capture ceremony, target identity, pre-state, supplied evidence, expected decision, observed decision, post-state, session or credential effect, notification, audit entry, cleanup, and whether the result generalizes to other channels.
