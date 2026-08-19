# Authorization Matrix

## Actors

Include anonymous, pending, active, suspended, user, manager, tenant administrator, platform administrator, support, auditor, delegated operator, service identity, integration, and background worker when present.

## Resources

Include individual objects, collections, child relationships, attachments, comments, secrets, credentials, configuration, audit events, exports, search indexes, aggregate counts, billing records, workflow tasks, tokens, jobs, and administrative resources.

## Actions

Cover discover, list, count, search, read, create, import, update, patch, delete, restore, transition, approve, reject, assign, share, delegate, impersonate, export, download, execute, retry, cancel, and view history.

## Decision dimensions

- tenant and organization membership;
- ownership and relationship;
- role, permission, entitlement, and delegated scope;
- object and workflow state;
- authentication assurance and recency;
- geography, environment, channel, or network when policy relies on it;
- time, expiry, suspension, revocation, or legal hold;
- property classification and purpose of use.

## Indirect authorization paths

Check search suggestions, autocomplete, counts, error differences, notification recipients, signed links, previews, thumbnails, caches, feeds, audit logs, exports, analytics, webhooks, background reports, object references in other resources, and shared storage keys.

## Matrix reduction

Reduce only when code or configuration proves a common dominating policy. Record the enforcement component, policy identifier, representative operations, and evidence that no path bypasses it. Expand whenever middleware, resolver, controller, repository, version, or asynchronous consumer differs.

## Runtime boundary

The campaign JSON records an authorization reference, exact origins, and conservative limits only. Those values constrain a known engagement; they do not grant authority and cannot select a proxy, CA bundle, or TLS policy. Cyberful owns the transport route after the model boundary: literal loopback IP targets run direct with proxy use disabled, while all other targets require the runtime-provided HTTP(S) proxy and CA bundle. Absence of that route is a preflight refusal before any request or secret resolution.
