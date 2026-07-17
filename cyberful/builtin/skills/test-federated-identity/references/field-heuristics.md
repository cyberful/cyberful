# Federated Identity Field Heuristics

## Cross-product testing

Construct an acceptance matrix rather than mutating one token at a time:

`issuer × client × redirect × response mode × token type × audience/resource × subject × tenant × assurance × endpoint`

Populate valid artifacts from at least two clients, users, tenants, and issuers when available. Replay each artifact at sibling consumers. The highest-yield bugs are often valid-artifact confusion, not broken signatures.

## Weak signals

- Two issuers expose overlapping key IDs or a consumer caches keys by kid without issuer.
- Discovery/metadata is selected from request-controlled tenant, domain, or issuer-like input.
- The callback accepts both query and form_post while state storage is mode-specific.
- Account linking starts authenticated but completes after a session/account switch.
- Email, preferred_username, tenant name, or domain is used as identity despite a stable issuer-qualified subject.
- A native and confidential client share redirect handlers or token audiences.
- A gateway validates signature/expiry while the service assumes audience, token type, or assurance.
- Logout, device authorization, CIBA, PAR/JAR/JARM, or token exchange uses a weaker binding model than login.

## JWT and key-resolution traps

Test claim duplication at the serialized/parser boundary, JSON type changes, Unicode claim names only when the actual stack permits them, nested JWT/JWE order, critical headers, detached payload behavior, x5c/x5u/jku/jwk resolution, key-type/algorithm compatibility, issuer-key cache partitioning, rotation overlap, and negative-cache behavior. Do not infer algorithm confusion without proving the configured library accepts the cross-type key use.

## OAuth/OIDC differentials

- Swap codes before and after PKCE verification across clients and redirect variants.
- Compare state/nonce handling across multiple tabs, retries, error callbacks, and login restarts.
- Test redirect canonicalization involving default ports, fragments stripped by browsers, userinfo, trailing dots, encoded path separators, loopback port rules, and custom-scheme ownership.
- Distinguish access, ID, refresh, device, and token-exchange artifacts at every consumer.
- Test resource indicators and audience narrowing after refresh or exchange.
- Check whether step-up claims survive refresh, account switch, or downstream token exchange beyond intended freshness.

## SAML differentials

Correlate the signature-covered element with the element consumed for identity, audience, recipient, destination, InResponseTo, session, and attributes. Inspect namespace-aware parsing, duplicate IDs, multiple assertions/responses, encryption/signature ordering, metadata key rollover, unsolicited responses, proxy restrictions, and IdP-initiated account/tenant selection. Preserve raw XML bytes because reserialization can erase decisive structure.

## Account-linking proof

Track the pre-link session, external issuer-qualified subject, local account ID, tenant, confirmation channel, and post-link session. Re-run with browser session switched between start and completion, reused link artifacts, existing local/federated collisions, changed email/phone, deprovisioned upstream identity, and relink after unlink. The proof is unintended account authority, not merely a duplicate account.

## False-negative traps

Only one issuer/client tested, no valid cross-tenant artifacts, metadata cached from an earlier run, key rotation not sampled, gateway versus service validation conflated, refresh/token-exchange paths omitted, browser SameSite behavior not reproduced, and local account-linking logic treated as an identity-provider concern.
