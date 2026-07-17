# Race, Transaction, and Idempotency Review

## Race Families

Examine:

- check-then-act authorization, balance, quota, inventory, and status transitions;
- read-modify-write lost updates;
- uniqueness enforced in application code;
- double redemption, transfer, refund, invite, or ownership change;
- file, symlink, and temporary-object TOCTOU;
- lock acquisition and expiry;
- cache/database incoherence;
- queue redelivery and consumer concurrency;
- cross-region replication and eventual-consistency windows;
- cleanup racing with use or reassignment.

## Code-Audit Questions

- Is the invariant represented by a unique constraint, check constraint, serializable transaction, atomic update predicate, or compare-and-swap?
- Does the transaction cover every dependent write and external outbox record?
- Can a lock expire while work continues, and is fencing used?
- Does retry logic rerun a non-idempotent side effect?
- Is the version checked at write time rather than only read time?
- Can two distinct identifiers address the same semantic object?

## Idempotency Design

Bind the key to authenticated principal, operation, canonical request hash, and a retention period at least as long as any retry or replay window. Store the final outcome atomically with the business transition. Reject key reuse with a different request.

An endpoint can be idempotent at the database yet duplicate email, payment, webhook, or queue side effects. Trace the outbox and provider boundary.

## Advanced Hints

- Force the slow path between validation and commit: cache miss, large but valid object, delayed external callback, or lock contention.
- Compare two endpoints that mutate the same invariant through different services.
- Race a privileged transition against role revocation, tenant move, logout, or object deletion.
- Test cancellation and timeout: clients often retry while the original operation continues.
- Inspect reconciliation jobs; they may reapply a side effect using weaker idempotency than the online path.
- In distributed locks, lack of a fencing token converts expired ownership into concurrent writers.
