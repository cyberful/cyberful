---
name: test-automated-account-abuse
description: Test automated account and resource abuse controls through authorized, rate-bounded experiments using tester-controlled identities. Use for signup, verification, credential stuffing, farming, and API automation.
metadata:
  domain: application-security
  subdomain: automated-account-abuse
  triggers:
    - automated signup abuse
    - account farming controls
    - credential stuffing defense
    - SMS verification abuse
    - anti-bot control testing
    - API automation abuse
  tags:
    - automation
    - account-abuse
    - anti-bot
    - credential-stuffing
    - verification
    - rate-limit
    - MITRE-F3
  frameworks:
    mitre_attack:
      - T1110.004
    nist_csf:
      - ID.RA-03
    mitre_f3:
      - F1002
      - F1003
---

# Test Automated Account Abuse

Test whether automation changes an account, verification, credential, or resource invariant. Use only authorized tester-controlled identities, fixed concurrency, rate and account ceilings, non-production communication sinks, and explicit stopping conditions. Do not generate unsolicited messages, consume scarce public resources, or bypass third-party platform controls.

## Define the experiment

Read [references/automation-abuse-testing.md](references/automation-abuse-testing.md) for identity and rate boundaries. Copy [assets/automation-abuse-plan.template.json](assets/automation-abuse-plan.template.json) and preserve [assets/automation-abuse-plan.schema.json](assets/automation-abuse-plan.schema.json) for a reviewed plan.

Name the protected invariant, controlled identity pool, surface, intended user action, automation distinction, request and concurrency ceilings, verification sink, expected control decision, authoritative evidence, cleanup, and stop condition. Separate signup farming, credential stuffing, verification exhaustion, resource reservation, and public API automation because their controls and harms differ.

## Run the minimum discriminating set

Establish one ordinary manual or low-rate control, then vary one bounded automation dimension such as cadence, parallelism, identifier reuse, session reuse, client channel, or lifecycle state. Never increase volume merely to find a threshold. Stop on third-party delivery, shared resource consumption, unexpected lockout, operational alert escalation, or any ceiling breach.

## Confirm control and effect

Collect rate or bot decisions, authentication or verification result, account lifecycle state, resource allocation, message count, lockout state, downstream durable effect, and cleanup. Treat status codes and UI challenges as observations, not proof of prevention. Confirm whether the invariant failed and whether the effect persisted beyond the request.

Map public API automation to F1002, SMS verification abuse to F1003, and credential stuffing to ATT&CK T1110.004 only when that exact behavior was exercised and evidenced.
