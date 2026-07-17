---
name: test-federated-identity
description: Test and audit OAuth 2.0, OpenID Connect, JWT, SAML, delegated authorization, token exchange, service federation, and account linking. Use for issuer or audience confusion, redirect and response-mode flaws, PKCE, nonce and state handling, assertion validation, signature and key lifecycle, scope escalation, client mix-up, token substitution, federation metadata, and cross-tenant identity mapping.
---

# Test Federated Identity

Model every participant and artifact before testing. A syntactically valid token or signed assertion is not valid for every issuer, client, audience, tenant, subject, action, or time.

## Build the federation graph

Record authorization server or identity provider, resource server or service provider, clients, redirect endpoints, browsers, back channels, issuers, audiences, keys, metadata, scopes, claims, subject mapping, tenant mapping, token types, logout paths, and trust administrators.

Read [references/oauth-oidc-jwt.md](references/oauth-oidc-jwt.md) for OAuth/OIDC/JWT and [references/saml-federation.md](references/saml-federation.md) for SAML.
Use [references/field-heuristics.md](references/field-heuristics.md) for mix-up, key-resolution, account-linking, and multi-tenant differentials that commonly escape checklist testing.

## Test artifact binding

For every code, token, assertion, challenge, response, or logout message verify:

- issuer and trusted metadata source;
- exact audience, recipient, client, redirect, resource, and token type;
- subject and tenant mapping;
- state, nonce, PKCE, request, session, and transaction binding;
- signature algorithm, key selection, key origin, and key status;
- validity window, replay handling, one-time use, and revocation expectations;
- assurance, authentication method, scope, claims, and delegation chain.

## Test account linking and provisioning

Check immutable versus mutable identifiers, email verification semantics, issuer-qualified subject keys, tenant selection, invitation binding, just-in-time role assignment, group mapping, deprovisioning, identifier recycling, and collisions between local and federated accounts.

## Test client and service boundaries

Separate public, confidential, native, browser, machine, and administrative clients. Check redirect registration, response modes, browser history and referrer exposure, front-channel versus back-channel delivery, client authentication, token storage, resource indicators, sender constraint, scope minimization, and unsafe token forwarding.

## Audit libraries and configuration

Identify the exact library, validation API, metadata cache, key resolver, algorithm policy, clock handling, and claims-to-local-identity transformation. Verify dangerous options are not enabled by compatibility fallbacks and that every consumer validates context independently.

## Confirmation standard

Confirm when an attacker can obtain, substitute, replay, redirect, mint, or use a federation artifact to assume unintended identity, tenant, client, resource, scope, or assurance. Do not report missing optional hardening without a path that changes security authority.

## Authoritative anchors

- OAuth 2.0 Security BCP, RFC 9700: https://www.rfc-editor.org/rfc/rfc9700
- OpenID Connect Core: https://openid.net/specs/openid-connect-core-1_0.html
- JWT BCP, RFC 8725: https://www.rfc-editor.org/rfc/rfc8725
- SAML 2.0 Security Considerations: https://docs.oasis-open.org/security/saml/v2.0/saml-sec-consider-2.0-os.pdf
