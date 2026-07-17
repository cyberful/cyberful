# Authentication Lifecycle Field Heuristics

## Ceremony cross-product

For each identity state, compare every way to create or regain authority: primary login, remembered device, refresh/session renewal, magic link, recovery, email/phone change, passkey, federated link, invitation, support override, and API/mobile legacy flow. The weakest ceremony defines practical assurance.

## Race and state-machine probes

- Complete the same single-use challenge concurrently from two sessions.
- Start recovery before password/factor change and complete it afterward.
- Start email/phone change, switch session/account/tenant, then complete.
- Approve and deny push challenges in reversed orders and across device re-enrollment.
- Redeem invitation after invited address, role, tenant, or existing-account binding changes.
- Begin authenticator replacement under high assurance, let assurance age, then complete.
- Suspend/delete/deprovision during an active ceremony and retry each outstanding artifact.

Record server state transitions and winning/losing responses; a UI message is not sufficient.

## Identifier and alias traps

Evaluate immutable internal identity separately from email, phone, username, federation subject, tenant alias, and support-visible handle. Test normalization at registration, lookup, notification, recovery, linking, uniqueness enforcement, and audit. High-yield cases involve two subsystems canonicalizing differently or a recycled external identifier binding to an old local identity.

## Authenticator replacement

Treat add, replace, reset, rename, recover, and remove as separate operations. Check fresh-auth requirements, factor independence, proof of possession, old-factor notification, pending state, rollback, session rotation, recovery-code invalidation, and whether removing the last strong factor silently downgrades the account.

For passkeys, record RP ID, origin, user verification, discoverable credential behavior, attestation policy, transports, backup eligibility/state, credential ID binding, and account-selection behavior. Do not equate platform UI with server enforcement.

## Support and administrative paths

Trace which evidence support sees, which fields it can mutate, whether maker/checker or reason controls exist, how impersonation is represented, and whether support actions issue durable recovery/session artifacts. Compare API and UI authorization and audit identity.

## False-negative traps

Only happy-path login tested, one client/platform used, outstanding challenges not replayed after state changes, no concurrency, aliases treated as immutable, authenticator removal ignored, remembered devices and refresh tokens omitted, and support/provisioning endpoints excluded from the ceremony map.

## Evidence standard

Preserve identity IDs, ceremony IDs, artifact fingerprints, start/complete times, session/tenant/assurance, state transitions, and control run. Confirmation requires unauthorized identity authority or retention, not merely inconsistent messages.
