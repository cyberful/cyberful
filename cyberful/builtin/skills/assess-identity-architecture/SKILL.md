---
name: assess-identity-architecture
description: Assess identity trust topology, assurance boundaries, issuer and relying-party responsibilities, and failure containment before testing a specific authentication or authorization mechanism.
metadata:
  domain: identity-security
  subdomain: identity-architecture
  triggers:
    - identity architecture review
    - federation trust topology
    - identity assurance boundary
    - issuer relying party review
    - authentication architecture assessment
  tags:
    - identity
    - trust-boundary
    - federation
    - assurance
    - architecture
  frameworks:
    nist_csf:
      - PR.AA-01
      - PR.AA-03
      - PR.AA-04
      - PR.AA-05
---

# Assess Identity Architecture

Model who establishes an identity fact, who transforms it, who consumes it, and which component owns the resulting security decision. Use this skill for architecture-wide assurance and failure containment; route concrete policy checks to `audit-access-policy-enforcement` and protocol execution to the relevant test skill.

## Establish the trust topology

Inventory human, workload, device, support, and external identities. For every issuer, broker, directory, authenticator, token service, gateway, relying party, policy decision point, and enforcement point, record its operator, trust anchors, identifiers, accepted assurance, revocation source, and tenant boundary.

Copy [assets/identity-trust-matrix.csv](assets/identity-trust-matrix.csv) when a durable topology is required. Read [references/identity-architecture-review.md](references/identity-architecture-review.md) before assessing a federation, migration, or shared identity platform.

## Evaluate architectural claims

Trace each material claim from authoritative source to enforcement. Distinguish proofing, authentication, authorization, delegation, impersonation, and tenant selection. Check whether transformations preserve issuer, subject, audience, client, assurance, freshness, actor-versus-subject, and revocation semantics.

Challenge the architecture with loss of one trust component: compromised client, stale directory, unavailable revocation feed, confused broker, duplicated subject, tenant reassignment, support override, or clock/key transition. Determine whether the failure is contained, detected, and recoverable without trusting the failed component.

## Produce the assessment

Report trust edges, authoritative owners, assumptions, unresolved evidence, concentration risk, and concrete specialist routes. An architectural weakness is not a demonstrated exploit; separate design exposure from an observed unauthorized decision.

Do not create principals, modify federation, rotate keys, or exercise recovery paths without explicit authority. Use synthetic identities and redacted claim summaries in durable artifacts.
