---
name: test-authentication-lifecycle
description: Test or audit the complete authentication and authenticator lifecycle. Use for registration, enrollment, login, passwordless and password authentication, MFA, recovery, credential change, device trust, account linking, reauthentication, lockout, support overrides, deprovisioning, and account-takeover analysis in dynamic tests or source review.
---

# Test the Authentication Lifecycle

Model every path that can create or strengthen an authenticated identity. The primary login form is only one ceremony.

## Inventory ceremonies

Enumerate registration, invitations, password setup, login, magic links, passkeys, OTP, push approval, backup codes, recovery, email or phone change, account linking, SSO bootstrap, device enrollment, remembered devices, step-up authentication, support override, impersonation, credential rotation, suspension, and deletion.

For each ceremony record:

`claimed identity | evidence required | channel | freshness | attempts | state created | assurance level | session effect | notification | audit event | revocation`

Read [references/lifecycle-checks.md](references/lifecycle-checks.md) for full state coverage and [references/mfa-recovery.md](references/mfa-recovery.md) for multi-factor and recovery-specific attacks.
Use [references/field-heuristics.md](references/field-heuristics.md) for multi-ceremony races, authenticator replacement, alias, and support-path differentials.

## Test identity binding

Verify that evidence is bound to the intended user, tenant, client, browser or device, transaction, redirect, purpose, and time window. Test identifier changes, normalization, aliases, recycled addresses or numbers, plus-addressing, Unicode, case folding, and duplicate identities only when relevant to the observed system.

Reject findings based only on enumeration or UX differences unless they create a realistic security effect. Preserve privacy implications separately.

## Test ceremony integrity

Check:

- server-generated unpredictability and single purpose of challenges;
- expiry, one-time use, replay rejection, and invalidation after state change;
- rate and cost controls keyed to target identity as well as source;
- no downgrade to a weaker channel or authenticator;
- fresh authentication before sensitive changes;
- atomic transition from pending to active state;
- no client-side authority over completion, assurance, or role;
- consistent behavior across web, mobile, API, support, and federation paths;
- notifications that do not become authorization tokens themselves.

## Test lifecycle transitions

Exercise expected-success and expected-denial transitions using tester-owned identities. Include pending, active, locked, disabled, suspended, deleted, invited, expired, recovered, and recently changed states. Check whether old credentials, challenges, sessions, devices, links, and recovery factors remain valid after transitions.

## Audit implementation

Trace controller or handler through identifier lookup, challenge creation, secure comparison, attempt accounting, identity binding, state mutation, session issuance, notification, and audit logging. Inspect alternative endpoints, background consumers, support tools, and failure fallbacks. Confirm secrets are never logged or placed in URLs when referrers, analytics, browser history, or intermediaries could retain them.

## Confirmation standard

Confirm only when an unauthorized actor can create, assume, recover, link, retain, or elevate an identity without the required evidence. State exact ceremony, target state, attacker capability, factor bypassed, session or credential obtained, and revocation behavior.

## Authoritative anchors

- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- NIST SP 800-63B-4: https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- WebAuthn Level 3: https://www.w3.org/TR/webauthn-3/
