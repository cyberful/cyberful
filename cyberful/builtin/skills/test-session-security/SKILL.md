---
name: test-session-security
description: Test and audit authenticated session state across cookies, opaque tokens, bearer tokens, refresh tokens, devices, browsers, APIs, and privilege transitions. Use for session fixation, hijacking, rotation, logout, expiry, revocation, concurrent sessions, remember-me, CSRF interaction, token storage, impersonation, and stale-session analysis.
---

# Test Session Security

Model the session as authority that changes over time. Separate session identifier, server-side state, access token, refresh credential, device record, CSRF state, and remembered-login credential.

## Map session artifacts

For each artifact record creation, transport, storage, scope, binding, entropy, rotation, expiry, renewal, revocation, logging, and downstream acceptance. Read [references/token-cookie-lifecycle.md](references/token-cookie-lifecycle.md).

## Test authority transitions

Observe identifier and authority before and after login, MFA completion, step-up, password or factor change, account switch, tenant switch, privilege elevation, impersonation start or end, recovery, suspension, logout, and account deletion.

Require rotation where pre-existing knowledge or weaker assurance must not survive. Preserve anonymous cart or preference data by migration into a new session, not by retaining the old authority identifier.

## Test expiry and revocation

Check idle and absolute expiry, refresh rotation, reuse detection, server-side invalidation, logout of current and all devices, administrative revocation, credential change, role change, account state change, and long-lived socket or background-job behavior. Compare edge, gateway, service, cache, and offline validation.

## Test browser interaction

Check cookie host/domain/path scope, prefixes, `Secure`, `HttpOnly`, `SameSite`, duplicate cookie behavior, subdomain planting, URL tokens, referrer leakage, browser storage, cache behavior, CSRF tokens, cross-origin credential use, framing, and service workers.

Read [references/session-attacks.md](references/session-attacks.md) for attack-path analysis.
Use [references/field-heuristics.md](references/field-heuristics.md) for duplicate-cookie, rotation, revocation, distributed-state, and long-lived-channel differentials.

## Audit implementation

Trace session creation and lookup, randomness, hashing at rest, serialization, rotation, renewal, privilege snapshot, revocation store, cache, cleanup, logging, and error fallbacks. Check whether downstream services validate current authority or trust stale token claims beyond accepted risk.

## Confirmation standard

Confirm only when an attacker can plant, predict, steal, replay, retain, or exercise session authority outside its intended identity, client, time, assurance, tenant, or lifecycle state. Distinguish direct token disclosure from ambient browser authority and from a mere cookie-hardening recommendation.

## Authoritative anchors

- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- RFC 6265bis: https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html
- OAuth 2.0 Security BCP: https://www.rfc-editor.org/rfc/rfc9700
