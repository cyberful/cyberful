# OAuth, OpenID Connect, and JWT

## Authorization request

Validate exact redirect registration, client identity, response type and mode, state binding, PKCE for applicable clients, nonce for OIDC, prompt and max-age semantics, resource indicators, requested scope, and protection against mix-up and authorization-request tampering. Prefer pushed or signed requests where the threat model requires them.

## Authorization response and code

Bind code to client, redirect, user session, PKCE verifier, issuer, transaction, and one-time redemption. Prevent leakage through URL, history, referrer, logs, analytics, and open redirects. Reject responses from unexpected issuers even when client identifiers overlap.

## Tokens

Distinguish ID, access, refresh, device, logout, and application session tokens. Validate intended token type, issuer, audience/resource, subject, client or authorized party, time, scope, tenant, and sender constraint. Never use an ID token as an access token or accept a token solely because its signature is valid.

## JWT validation

Pin allowed algorithms by context. Reject `none`, algorithm confusion, attacker-selected keys, untrusted `jku`/`x5u`, unsafe embedded keys, duplicate claims, ambiguous JSON, unsupported critical headers, and keys outside trusted issuer metadata. Define key rotation, cache expiry, unknown key IDs, and fail-closed behavior.

## Delegation and exchange

Track original actor, subject, audience, scope, tenant, and delegation chain. Prevent token exchange or on-behalf-of flows from broadening authority. Do not forward powerful upstream tokens to downstream services that need narrower credentials.

## Device and browser flows

Bind user codes and device codes, limit attempts, prevent phishing through verification URI confusion, and make authorization context explicit. For browser-based clients, follow current BCP guidance rather than relying on legacy implicit-flow assumptions.

## Logout and revocation

Verify local session termination, provider session expectations, refresh revocation, token-family behavior, back-channel and front-channel logout validation, and stale resource-server acceptance.
