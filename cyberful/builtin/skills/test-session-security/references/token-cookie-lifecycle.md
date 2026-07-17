# Token and Cookie Lifecycle

## Identifier properties

Require cryptographically strong generation, sufficient entropy, no meaningful structure, safe encoding, constant-time verification where secret comparison occurs, and rotation at authority boundaries. Prefer storing hashes of high-value opaque credentials when feasible.

## Cookie scope

Use host-only scope unless cross-host sharing is essential. Minimize path scope, use secure prefixes where compatible, avoid sibling-domain planting, and define duplicate-name behavior. `SameSite` is a browser delivery policy, not a complete CSRF control or authorization decision.

## Bearer and refresh credentials

Constrain issuer, audience, client, scope, tenant, subject, token type, time, and proof-of-possession where relied upon. Keep access lifetimes short enough for revocation risk. Rotate refresh tokens, bind token families, detect reuse, and revoke the family after confirmed theft according to product policy.

## Renewal

Prevent endless sliding sessions from defeating absolute lifetime. Ensure renewal cannot revive suspended, deleted, deprovisioned, or lower-authority state. Re-evaluate policy-sensitive claims rather than copying stale snapshots indefinitely.

## Storage and transport

Prevent URL, log, analytics, referrer, crash-report, clipboard, browser-extension, backup, mobile log, and inter-process leakage. Separate CSRF exposure, XSS exposure, local malware, and server compromise in the threat model.

## Auditability

Log session creation, rotation, refresh reuse, revocation, privilege transition, impersonation, and suspicious concurrency with non-secret identifiers that support incident reconstruction.
