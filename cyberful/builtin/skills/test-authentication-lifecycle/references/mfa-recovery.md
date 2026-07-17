# MFA, Passwordless, and Recovery

## Multi-factor composition

Determine whether factors are genuinely independent. A password and email OTP may collapse when mailbox access depends on the same session. Device possession plus a device-stored unlock secret may or may not meet the product's claimed assurance. Document product assurance rather than assigning labels from UI text.

Test enrollment, activation, challenge, fallback, replacement, reset, factor removal, trusted device, remembered browser, backup codes, help-desk recovery, lost-device recovery, and step-up flows.

## Challenge binding

Bind a challenge to account, factor, ceremony, transaction, client, session, nonce, creation time, and attempt state. Verify that completing one challenge cannot satisfy another account, transaction, action, or browser context.

## Push and OTP

Review number matching, transaction context, prompt bombing resistance, expiry, replay, attempt accounting, destination change, notification fatigue, and acceptance after the initiating session ends. Do not generate uncontrolled messages or costs.

## Passkeys and WebAuthn

Verify RP ID and origin binding, challenge freshness, user verification policy, discoverable credential behavior, credential registration authorization, attestation policy where relied upon, counter or backup-state handling, and account recovery that does not undermine passkeys.

## Recovery is authentication

Treat recovery as a parallel authentication protocol. Check identifier enumeration, token entropy, delivery channel, link leakage, expiry, one-time use, brute-force resistance, session invalidation, factor reset, notification, audit, and support escalation. Recovery must not silently grant a higher assurance level than the evidence supports.
