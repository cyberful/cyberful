---
name: audit-security-logging-telemetry
description: Audit security logging and telemetry from event creation through transport, storage, access, correlation, retention, and response use. Use to assess whether protected actions remain reconstructable under failure and adversarial pressure.
metadata:
  domain: detection-response
  subdomain: security-telemetry
  triggers:
    - security logging audit
    - telemetry coverage review
    - audit trail integrity
    - detection evidence assessment
    - log retention controls
    - incident reconstruction readiness
  tags:
    - logging
    - telemetry
    - audit-trail
    - detection-engineering
    - retention
    - evidence-integrity
  frameworks:
    nist_csf:
      - DE.CM-01
      - DE.CM-09
      - DE.AE-03
---

# Audit Security Logging and Telemetry

Audit the complete evidence path, not the presence of logger calls. A useful event must be created at the protected decision, carry enough identity and causal context, survive transport and storage, remain access-controlled and time-coherent, and support an actual detection or reconstruction question.

## Build the evidence chain

Read [references/telemetry-evidence-method.md](references/telemetry-evidence-method.md). Populate [assets/telemetry-coverage-ledger.example.json](assets/telemetry-coverage-ledger.example.json) under [assets/telemetry-coverage-ledger.schema.json](assets/telemetry-coverage-ledger.schema.json). Start from protected effects and abuse cases, then trace event producer, schema, correlation identifiers, clock source, buffering, transport, transformations, destination, retention, access, alert consumer, and evidence query.

Exercise success, denial, partial failure, retry, asynchronous continuation, privileged override, and destructive administration paths. Verify that sensitive fields are minimized and that log injection, truncation, duplicate delivery, loss, sampling, backpressure, time skew, tenant mixing, and operator tampering do not silently destroy meaning.

## Confirm evidentiary impact

Report a gap only with the question that cannot be answered or the detection that cannot run, the affected event path, and the shortest reproducible loss or ambiguity mechanism. Separate absent telemetry, malformed semantics, unavailable retention, excessive observer authority, and an untested alert from a confirmed missed event.
