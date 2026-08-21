---
name: test-authorization-boundaries
description: Test authorization decisions across tenants, objects, properties, functions, relationships, workflows, services, caches, and delegated administration. Use for IDOR or BOLA, BFLA, privilege escalation, mass assignment, multi-tenant isolation, confused deputies, and policy-enforcement review.
metadata:
  domain: application-security
  subdomain: authorization
  triggers:
    - authorization boundary
    - access control
    - tenant isolation
    - privilege escalation
    - object-level authorization
    - function-level authorization
  tags:
    - idor
    - bola
    - bfla
    - tenant-isolation
    - mass-assignment
    - confused-deputy
  frameworks:
    mitre_attack:
      - T1078
    nist_csf:
      - PR.AA-05
---

# Test Authorization Boundaries

Treat every security decision as a tuple, not a role check:

`actor | authenticated identity | tenant | resource | relationship | action | properties | workflow state | assurance | environment`

## Build the authorization matrix

Read [references/authorization-matrix.md](references/authorization-matrix.md). Inventory resources, collections, relationships, actions, field groups, state transitions, administrative capabilities, and machine-to-machine operations. Include read, search, count, export, history, attachment, bulk, indirect relationship, and asynchronous paths.

Identify the authoritative policy owner for each decision. Gateway authentication, UI visibility, and possession of an object identifier are not authorization.

## Test horizontally and vertically

Use provided tester-owned accounts and objects. Compare:

- same role, same tenant, different owner;
- same role, different tenant;
- lower versus higher role;
- current versus former collaborator;
- direct object access versus collection, search, relationship, or export access;
- synchronous request versus queued job, webhook, report, notification, or cached response;
- ordinary versus bulk, legacy, mobile, GraphQL, or administrative operation.

Change one decision dimension at a time. Preserve exact request and identity context.

## Test property and mutation authorization

For each create or update path, derive server-owned, immutable, write-once, role-restricted, tenant-bound, workflow-controlled, and computed fields. Test object binding, merge semantics, patch operations, nested properties, relationship IDs, defaults, nulls, and duplicate keys. Confirm the server derives security-sensitive fields from authoritative state.

## Audit policy placement

Read [references/enforcement-review.md](references/enforcement-review.md). Trace from entry point to policy decision and resource access. Check middleware exclusions, resolver or controller gaps, direct repository calls, service-to-service trust, cached policy decisions, background work, event replay, and fail-open behavior.

Use [references/field-heuristics.md](references/field-heuristics.md) after the base matrix to locate aliasing, stale authority, indirect disclosure, and multi-step privilege chains.

## Run a bounded campaign

Use [scripts/run_authorization_campaign.py](scripts/run_authorization_campaign.py) only after the effective matrix, controlled actors, target origins, request ceiling, rate, and authorization reference are explicit. Copy [assets/authorization-campaign.example.json](assets/authorization-campaign.example.json), preserve [assets/authorization-campaign.schema.json](assets/authorization-campaign.schema.json), and keep secrets only in the environment variables declared by [scripts/manifest.json](scripts/manifest.json). Never place authorization, cookie, proxy-authorization, transport configuration, or any declared secret header value in the JSON header map.

The runner validates every case before resolving secret environment values or issuing the first request. Exact origins and limits are defense in depth and never grant authority. Literal loopback targets run direct with proxies disabled; every other target requires the host-owned HTTP(S) proxy and CA route described by [scripts/manifest.json](scripts/manifest.json). Missing transport refuses before connection, TLS verification is never disabled, and bounded, secret-redacted raw transport evidence conforms to [assets/authorization-campaign-evidence.schema.json](assets/authorization-campaign-evidence.schema.json). The runner terminates the full process group as soon as a stream, response, or global deadline boundary is crossed. It does not compare policy with outcomes or issue a vulnerability verdict; perform that reasoning from the raw controls and durable effects.

## Confirm impact precisely

Confirm when the tested actor can read, infer, create, modify, delete, transition, invoke, delegate, or export outside the intended policy. State actor, target resource, tenant, action, expected policy, actual decision, effect, and whether enforcement is shared by other operations.

Do not access unrelated real-user data merely to prove enumeration. Prefer paired tester-controlled tenants and synthetic objects.

Read [references/framework-mapping.md](references/framework-mapping.md) only when the deliverable needs framework alignment. Map a demonstrated mechanism or control outcome, never the skill name alone, and leave irrelevant frameworks unmapped.

## Authoritative anchors

- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP API Security Top 10: https://owasp.org/www-project-api-security/
- OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
- NIST SP 800-162 ABAC: https://csrc.nist.gov/pubs/sp/800/162/upd2/final
