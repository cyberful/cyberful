---
name: test-account-recovery-assurance
description: Test account and authenticator recovery as an assurance transition, including proofing, channel changes, support overrides, replay resistance, and post-recovery invalidation.
metadata:
  domain: identity-security
  subdomain: account-recovery
  triggers:
    - account recovery testing
    - password reset assurance
    - MFA recovery security
    - authenticator replacement
    - support recovery review
    - recovery token replay
  tags:
    - account-recovery
    - password-reset
    - MFA
    - identity-proofing
    - session-revocation
    - account-takeover
  frameworks:
    mitre_attack:
      - T1078
      - T1098
    nist_csf:
      - PR.AA-02
      - PR.AA-03
---

# Test Account Recovery Assurance

Treat recovery as issuance of new authority, not a convenience login. Test one controlled account at a time and preserve a known restoration path. Do not lock, suspend, unlink, or recover real-user accounts.

## Model the ceremony

Copy [assets/recovery-ceremony-ledger.csv](assets/recovery-ceremony-ledger.csv) and record entry conditions, claimed identity, required evidence, delivery channel, challenge lifetime, attempts, state transitions, new authenticators, session effects, notifications, and audit events.

Read [references/recovery-assurance-method.md](references/recovery-assurance-method.md) before exercising support-assisted recovery, factor replacement, or identifier change.

## Compare assurance paths

Establish a successful owner control, an insufficient-evidence control, and a replay control. Compare password reset, factor reset, backup code, lost-device, email or phone change, support override, delegated administrator, and federated fallback paths. Change one evidence element at a time.

Check whether enumeration, challenge reuse, parallel ceremonies, stale cookies, channel reassignment, previous device trust, or recently changed identity attributes can lower assurance. Verify that recovery completion invalidates superseded challenges, authenticators, sessions, API keys, remembered devices, and recovery artifacts according to policy.

## Confirm the outcome

Confirm only when an actor lacking the required evidence can assume or retain account authority, replace an authenticator, suppress owner notice, or preserve a superseded session. Record the exact ceremony, evidence accepted, prior and resulting assurance, session impact, notification, and cleanup.

Stop before destructive or irreversible transitions not explicitly authorized. Restore the tester-controlled account and verify its authenticators and sessions after every completed test path.
