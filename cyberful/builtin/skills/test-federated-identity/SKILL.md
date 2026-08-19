---
name: test-federated-identity
description: Route an identity assessment across federation architecture, policy enforcement, identity and tenant propagation, workload identity, recovery assurance, linking, and provisioning. Use when OAuth, OpenID Connect, SAML, JWT, token exchange, service federation, or account association spans more than one specialist boundary.
metadata:
  domain: identity-security
  subdomain: federated-identity
  triggers:
    - oauth security review
    - openid connect testing
    - saml federation testing
    - jwt validation
    - token exchange
    - account linking
  tags:
    - oauth
    - oidc
    - saml
    - jwt
    - federation
    - token-exchange
  frameworks:
    mitre_attack:
      - T1078
      - T1528
      - T1550.001
    nist_csf:
      - PR.AA-03
      - PR.AA-04
      - PR.AA-05
---

# Test Federated Identity

Use this router when the identity path crosses issuers, clients, brokers, applications, tenants, or service identities. Read each selected specialist's `SKILL.md` completely before applying its procedure.

## Route by boundary

- Trust topology, issuer/client roles, protocol choice, assurance, or federation design: `assess-identity-architecture`.
- Policy ownership, permission evaluation, entitlement rules, deny behavior, or enforcement placement: `audit-access-policy-enforcement`.
- Claims, credentials, delegated identity, or assurance lost or transformed across services: `trace-identity-propagation`.
- Tenant selection, organization context, routing, caches, jobs, or downstream tenant binding: `trace-tenant-context-propagation`.
- OAuth clients, service accounts, workload federation, token exchange, audience binding, or machine identity: `test-service-workload-identity`.
- Password reset, factor reset, support recovery, fallback identity proofing, or post-recovery invalidation: `test-account-recovery-assurance`.
- Account linking, invitation, merge, SCIM/JIT provisioning, deprovisioning, or identity reassignment: `test-identity-linking-provisioning`.

## Establish the shared identity record

Record the controlled principal, issuer, subject, client, tenant or organization, audience, scopes, authentication context, token or assertion type, relying party, and intended account. Preserve raw artifacts securely and compare semantic claims, key selection, and current account state without exposing credentials.

Use two controlled principals or tenants when the route requires cross-boundary comparison. Do not create identities, link accounts, consent applications, or alter federation configuration unless those mutations are expressly authorized.

If expressly authorized dynamic client registration creates one uniquely marked test client, the absence of a documented client-deletion endpoint is a cleanup limitation, not an approval gate; record it and do not improvise an administrative mutation.

## Integrate findings

State which component owned the failed decision, which identity or tenant attribute was trusted, how it propagated, and what authority resulted. A malformed token rejection, verbose error, or permissive client behavior is not a vulnerability without a server-side acceptance or security effect.
