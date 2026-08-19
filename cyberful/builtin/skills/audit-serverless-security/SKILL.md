---
name: audit-serverless-security
description: Audit serverless applications for event-source authority, function identity, tenant context, data exposure, retry behavior, deployment controls, and unsafe service integrations. Use for Lambda, Cloud Functions, Azure Functions, edge functions, or event-driven serverless review.
metadata:
  domain: cloud-security
  subdomain: serverless-applications
  triggers:
    - serverless security audit
    - lambda security review
    - cloud functions audit
    - function event authorization
    - serverless tenant isolation
    - event retry security
  tags:
    - serverless
    - event-sources
    - function-identity
    - tenant-isolation
    - cloud-functions
    - asynchronous-processing
  frameworks:
    nist_csf:
      - PR.AA-05
      - PR.PS-01
      - ID.RA-01
---

# Audit Serverless Security

Model the application as event sources, function identities, service integrations, asynchronous state, and deployment policies. Do not treat the function handler as the whole trust boundary: provider bindings and retry paths often decide authority before or after the code runs.

## Trace event authority

Read [references/serverless-boundary-method.md](references/serverless-boundary-method.md). Populate [assets/serverless-boundary-ledger.example.json](assets/serverless-boundary-ledger.example.json) using [assets/serverless-boundary-ledger.schema.json](assets/serverless-boundary-ledger.schema.json). For each trigger, record who can emit it, which identity executes, how tenant and actor context are derived, which destinations are reachable, and what happens on retry, duplication, delay, or dead-letter delivery.

Inspect deployment templates, resource policies, event filters, IAM bindings, environment variables, secret references, temporary storage, concurrency, egress, observability, and failure destinations. Confirm provider defaults from supplied configuration or authoritative deployment evidence rather than memory.

## Report boundaries

Confirm a finding when an untrusted producer, confused service, or over-broad function identity can cause a protected effect or cross a tenant/data boundary. Separate code defects from resource-policy, event-binding, deployment, and operational gaps so ownership and remediation remain precise.
