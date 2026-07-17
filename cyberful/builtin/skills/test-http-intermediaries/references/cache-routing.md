# Cache and Routing Review

## Derive the Effective Cache Key

List every input that can change content or security meaning: host, scheme, path, query, method, headers, cookies, locale, encoding, device class, authorization, tenant, feature flags, and upstream identity. Determine which inputs enter the key, bypass decision, or downstream fragment key.

Test one dimension at a time. Inspect `Age`, `Vary`, cache status, surrogate keys, ETags, stale behavior, and timing. Use unique cache busters and confirmed expiry.

## High-Yield Poisoning Surfaces

Prioritize unkeyed inputs affecting:

- generated links, script imports, and canonical URLs;
- redirects;
- content negotiation and compressed variants;
- security headers;
- routing and tenant branding;
- edge-side includes and fragment composition;
- error documents, negative caching, and stale-if-error.

Prove storage by retrieving attacker influence with a clean request. Reflection before a cache is not poisoning.

## Cache Deception

Compare edge and origin classification of file-like suffixes, delimiters, path parameters, encoded separators, ignored path information, and rewrite rules. Determine whether authorization, `Set-Cookie`, or private cache directives actually prevent storage.

## Routing and Host Trust

Establish the trusted-proxy boundary. Reject or overwrite forwarding metadata from untrusted peers, validate public hosts, and generate security-sensitive absolute URLs from trusted configuration.

Look for split routing where TLS SNI, `:authority`, `Host`, absolute target, and a rewrite header select different tenants or services. This frequently reveals both access-control and cache-partition failures.

## False-Negative Traps

- Testing only cache hits while stale revalidation or error caching uses a different key.
- Ignoring CDN normalization because the origin appears correct.
- Testing one POP, protocol, or compression variant.
- Assuming authenticated responses never cache without measuring actual edge behavior.
- Missing fragment caches, application caches, and service-worker caches behind the main CDN.
