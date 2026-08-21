---
name: test-serverless-event-security
description: Test authorized serverless event handlers for source authority, signature and replay controls, tenant binding, schema validation, retry behavior, idempotency, and side-effect isolation using bounded synthetic events.
metadata:
  domain: cloud-security
  subdomain: serverless-event-security
  triggers:
    - test serverless event security
    - webhook function authorization
    - event source signature test
    - serverless replay assessment
    - function idempotency test
  tags:
    - serverless
    - events
    - webhooks
    - signatures
    - replay
    - idempotency
  frameworks:
    nist_csf:
      - PR.AA-05
---

# Test Serverless Event Security

Treat transport admission, event-source identity, signature canonicalization, schema, tenant context, retry, dead-letter routing, and downstream effect as independent boundaries. Use only synthetic events and reversible effects owned by the engagement.

Read [serverless-event-method.md](references/serverless-event-method.md) before varying signature, replay, or delivery metadata.

For bounded HTTP event probes in Pentest or Bug Bounty, stage [scripts/run_serverless_event_probe.py](scripts/run_serverless_event_probe.py), its [manifest](scripts/manifest.json), and the [example](assets/serverless-event-probe.example.json). The fixed-curl helper accepts attribution and defense-in-depth limits rather than authority, resolves `CYBERFUL_SERVERLESS_AUTHORIZATION` and `CYBERFUL_SERVERLESS_SIGNATURE` only after full preflight, and obtains non-loopback route and trust solely from Cyberful runtime environment. It is unavailable for Code Audit target traffic.

## Confirm an event invariant

Run matched control/candidate events that differ in one source, tenant, timestamp, identifier, schema version, signature state, or retry condition. Preserve request digest, delivery metadata, function outcome, durable side effect, duplicate behavior, and cleanup. Broker or gateway acceptance alone is not proof of an application effect.

Route multi-consumer broker semantics to `test-event-queue-boundaries` and broad function configuration review to `audit-serverless-security`.
