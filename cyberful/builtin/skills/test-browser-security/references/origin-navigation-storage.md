# Origin, Navigation, Messaging, and Storage

## Messaging and Window Relationships

For `postMessage`, verify both sender and receiver:

- exact target origin for sensitive messages;
- canonical `event.origin` allowlist;
- `event.source` bound to the expected window or frame;
- message schema and semantic authorization;
- no message-selected dangerous method, URL, or DOM sink.

Review opener access, reverse tabnabbing, frame ancestry, sandbox flags, popup login flows, document.domain legacy, and confused-deputy behavior between sibling subdomains.

## Storage and Worker Boundaries

Inventory cookies, local and session storage, IndexedDB, Cache Storage, client databases, credential APIs, service-worker caches, push data, and offline queues. Determine confidentiality, integrity, lifecycle, tenant separation, logout deletion, and exposure to any same-origin script.

For service workers, review scope, update source, cache key composition, response provenance, offline authorization, navigation handling, and persistence after account or tenant changes.

## Cross-Site Leak Families

Use matched baselines and repeatable low-impact signals:

- frame or popup navigation state;
- resource load success, dimensions, errors, and timing;
- cache state and conditional requests;
- connection limits and event ordering;
- window properties and cross-origin isolation differences.

Report an XS-Leak when the signal reliably reveals protected state, not when timing distributions merely overlap differently in a small sample.

## Redirect and URL Safety

Canonicalize with the same parser used for navigation. Verify scheme, host, port, credentials, Unicode and percent encoding, network-path references, backslashes, nested return URLs, and fragments. Prefer server-issued opaque continuations for sensitive flows.

An open redirect gains impact when chained into OAuth callbacks, token delivery, trusted-domain allowlists, security filters, deep links, or phishing-resistant navigation assumptions.

## False-Negative Traps

- Browser tests run without the production CSP, CDN rewrites, service worker, or same cookie attributes.
- CORS preflight is tested while the exploitable request is a simple form or text/plain request.
- CSRF tokens are present but not bound to the session, action, or authenticated identity.
- Message origins are checked by suffix or substring and accept attacker-controlled registrable domains.
- Logout clears server state but leaves offline caches or bearer material usable.
