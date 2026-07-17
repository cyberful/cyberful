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
