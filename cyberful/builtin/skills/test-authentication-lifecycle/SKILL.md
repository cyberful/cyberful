---
name: test-authentication-lifecycle
description: Coordinate testing of authentication and authenticator state across registration, login, MFA, recovery, linking, federation, device trust, reauthentication, suspension, and revocation. Use for cross-ceremony lifecycle coverage; use a narrower identity specialist for one ceremony or enforcement mechanism.
metadata:
  domain: application-security
  subdomain: authentication-routing
  triggers:
    - authentication lifecycle
    - MFA recovery
    - password reset security
    - authenticator enrollment
    - account takeover testing
    - credential revocation
  tags:
    - authentication
    - MFA
    - WebAuthn
    - account-recovery
    - NIST-SP-800-63B
    - OWASP-ASVS
  frameworks:
    mitre_attack:
      - T1078
    nist_csf:
      - PR.AA
---

# Test the Authentication Lifecycle

Own the cross-ceremony state model; route each mechanism to the narrowest specialist.

## Build the ceremony ledger

Inventory registration, invitation, login, passkeys, OTP, push, backup codes, recovery, identifier change, account linking, SSO bootstrap, device enrollment, remembered devices, step-up, support override, impersonation, rotation, suspension, deletion, and deprovisioning.

For every ceremony record:

`claimed identity | evidence | channel | freshness | attempts | prior state | next state | assurance | session effect | notification | audit event | revocation`

Use [references/lifecycle-checks.md](references/lifecycle-checks.md) to find missing states. Use [references/field-heuristics.md](references/field-heuristics.md) only for seams between ceremonies.

## Route the mechanisms

- Recovery proof, authenticator replacement, and invalidation: `test-account-recovery-assurance`.
- Linking, invitations, provisioning, and aliases: `test-identity-linking-provisioning`.
- OIDC, OAuth, SAML, and federation: `test-federated-identity`.
- Service and workload credentials: `test-service-workload-identity`.
- End-to-end identity context: `trace-identity-propagation`.
- Policy placement and default-deny behavior: `audit-access-policy-enforcement`.
- Session issuance, rotation, and revocation: `test-session-security`.

Read [references/mfa-recovery.md](references/mfa-recovery.md) only when coordinating MFA or recovery coverage. Do not repeat specialist test steps here.

## Integrate results

Compare expected-success and expected-denial transitions across web, mobile, API, support, and federated channels. Reconcile whether old credentials, challenges, sessions, devices, links, and recovery factors survive each state transition. Confirm only when an unauthorized actor can create, assume, recover, link, retain, or elevate an identity without the required evidence; name the ceremony, state transition, factor bypassed, session effect, and revocation result.
