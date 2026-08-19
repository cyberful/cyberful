---
name: test-service-workload-identity
description: Test service accounts, OAuth clients, workload federation, token exchange, audience binding, delegated actors, credential rotation, and machine-identity authorization.
metadata:
  domain: identity-security
  subdomain: workload-identity
  triggers:
    - workload identity testing
    - service account security
    - oauth client credentials
    - token exchange testing
    - workload federation review
    - machine identity authorization
  tags:
    - workload-identity
    - service-account
    - oauth
    - token-exchange
    - audience-binding
    - credential-rotation
  frameworks:
    mitre_attack:
      - T1528
      - T1550.001
    nist_csf:
      - PR.AA-03
      - PR.AA-04
      - PR.AA-05
---

# Test Service and Workload Identity

Treat a workload identity as a principal with its own lifecycle and policy, not as a trusted transport. Distinguish workload actor, delegated human subject, client, issuer, audience, tenant, scopes, credential, and execution environment.

## Establish the identity contract

Read [references/workload-identity-method.md](references/workload-identity-method.md). Inventory issuance, federation, exchange, storage, delivery, rotation, revocation, and authorization. Record which runtime attributes are attested, which system maps them to an internal principal, and where delegated user context is preserved.

Create expected-success and expected-denial controls using tester-owned workloads and resources. Vary one property at a time: issuer, subject, audience, client, tenant, scope, token type, actor chain, credential state, environment, or target service.

## Run a bounded HTTP probe

Use [scripts/run_workload_identity_probe.py](scripts/run_workload_identity_probe.py) only after authority, exact origins, controlled identities, request ceiling, rate, and restoration steps are explicit. Copy [assets/workload-identity-probe.example.json](assets/workload-identity-probe.example.json), preserve [assets/workload-identity-probe.schema.json](assets/workload-identity-probe.schema.json), and keep reusable credentials only in the variables declared by [scripts/manifest.json](scripts/manifest.json).

The mission-bound Cyberful gateway or ZAP route is the transport authority. Campaign JSON is defense in depth: it can narrow exact origins, request limits, and an external authorization reference, but it cannot choose a proxy or CA bundle. The probe refuses a non-loopback HTTP(S) target unless cyberful-os supplied the matching `HTTP_PROXY` or `HTTPS_PROXY`; it inherits only that route and `SSL_CERT_FILE` or `CURL_CA_BUNDLE` after the model boundary. Loopback IP literals explicitly bypass proxy inheritance, and TLS verification remains enabled. The fixed `curl` command also enforces a global monotonic deadline, hard file limits, process-group cleanup, and secret redaction. Its output follows [assets/workload-identity-evidence.schema.json](assets/workload-identity-evidence.schema.json) and contains transport evidence, not a vulnerability verdict.

Code Audit must not execute this target-network probe. Audit source and configuration offline or use an authorized loopback lab.

## Confirm authority changes

Confirm only when the receiving service accepts a workload or delegated identity outside its issuer, audience, tenant, scope, credential state, or actor policy and produces a protected effect. Record the identity tuple, expected binding, actual response, durable effect, replay conditions, and revocation result. Never persist raw credentials in artifacts.
