# Authorization Field Heuristics

## Mutate One Tuple Dimension

Keep the request structurally valid and change only one of actor, effective identity, tenant, resource alias, relationship, action, field set, state, assurance, or environment. Then repeat through a different entry point to determine whether policy is centralized or merely duplicated.

Use paired controlled objects whose identifiers differ in format, age, parent, visibility, and lifecycle state. Authorization defects often depend on representation rather than raw predictability.

## Alias and Indirection Paths

- Address the same resource by internal ID, public ID, slug, filename, composite key, relationship path, global node ID, signed URL, search hit, export row, attachment, or historical version.
- Test parent authorization versus child authorization and child reassignment after a parent check.
- Follow references embedded in comments, audit records, notifications, previews, thumbnails, activity feeds, and support views.
- Compare direct access with batch, import, export, retry, restore, clone, share, and transfer actions.
- Inspect canonicalization of tenant and resource identifiers across case, Unicode, leading zeros, deleted-and-recreated objects, and regional replicas.

## Stale Authority

Race or sequence membership removal, role downgrade, suspension, ownership transfer, tenant migration, object deletion, and assurance expiry against:

- open sessions and sockets;
- cached policy decisions;
- pre-signed links and export jobs;
- queued tasks and scheduled reports;
- invitations and share links;
- search and analytics indexes;
- offline or edge verification.

Record whether the system deliberately snapshots authority or unintentionally retains it.

## Delegation and Confused Deputies

- Check whether support, impersonation, integrations, service accounts, and delegated administrators preserve original actor, target tenant, purpose, and scope.
- Test who can create, edit, trigger, or inspect an automation that runs under a stronger identity.
- Verify resource-scoped delegation cannot select another resource through nested IDs, filters, templates, callbacks, or destination parameters.
- Look for "act as" headers accepted directly on internal or origin routes.
- Confirm approval and separation-of-duty rules bind the proposed canonical action, not a mutable draft.

## Data-Layer and Cache Clues

- ORM default scopes can disappear in raw queries, counts, joins, eager loads, and background jobs.
- DataLoader or cache keys missing tenant or policy version create cross-principal reuse.
- Filtering after retrieval leaks counts, timing, errors, memory pressure, or data through logs.
- A negative authorization cache can become allow-on-error after policy service timeout.
- Object storage and search indexes frequently use a different authorization model from the primary database.

## High-Confidence Evidence

Prefer a differential showing a denied control actor and an allowed unintended actor against the same controlled resource. Capture durable state and secondary effects; a successful status code may mask rollback, while an error may occur after the unauthorized write committed.
