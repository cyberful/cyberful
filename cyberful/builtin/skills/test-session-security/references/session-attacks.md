# Session Attack Paths

## Fixation and planting

Test whether an attacker-known pre-authentication identifier survives login or step-up; whether sibling domains, URL parameters, headers, or alternate clients can plant state; and whether SSO or magic-link callbacks bind into an existing attacker-chosen session.

## Theft and disclosure

Trace browser injection, logs, URLs, analytics, caches, source maps, error pages, mobile storage, backups, support tools, proxy headers, cross-origin responses, and insecure transport. Prove access to authority, not merely presence of a non-sensitive identifier.

## Replay and binding

Check replay across devices, clients, tenants, environments, regions, services, token types, and assurance levels. Binding controls must be enforceable and recoverable; brittle IP binding may create denial of service without preventing theft.

## Revocation gaps

Check local logout versus global logout, access versus refresh credentials, sockets, offline verification, caches, queues, signed URLs, background jobs, API keys, and service sessions after account or permission changes.

## Session confusion

Test account and tenant switching, multiple tabs, concurrent login, impersonation, mixed cookies and headers, token type confusion, duplicated cookies, stale CSRF state, and workflows that combine anonymous and authenticated objects.
