# Database boundary method

## Follow one effect

Begin with a concrete read or mutation and identify the caller-visible object, authority source, tenant source, selector, query builder, database credential, database policy, transaction, and committed state. Record which values are data, which become query structure, and which are derived from ambient context.

## Reconcile enforcement layers

Compare application predicates, repository defaults, row-level security, views, grants, and stored procedures. Test whether bulk methods, joins, preload paths, background workers, migrations, and administrative helpers bypass the layer relied upon by ordinary requests.

## Preserve temporal semantics

Authorization checked before a transaction may be stale at commit. Trace isolation level, locks, optimistic version checks, retry loops, replicas, cache invalidation, outbox publication, and rollback. Determine which durable effects can survive when a later step fails.

## Bound conclusions

Record generated SQL or an equivalent query plan with parameter values redacted, the credential and policy context, affected row identifiers, before/after state references, and transaction outcome. Do not call a query vulnerable solely because it contains dynamic behavior; demonstrate how untrusted influence changes query structure or protected selection.
