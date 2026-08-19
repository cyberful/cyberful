# Policy enforcement review

Use this reference when source or configuration contains a shared policy layer, multiple enforcement points, cached decisions, or asynchronous effects.

## Decision path

Trace this sequence without stopping at the policy call:

`entry point → canonical identity/tenant → resource resolution → decision inputs → policy version → decision → enforcement → durable effect → audit event`

Record aliases and alternate routes to each effect. A correct primary route does not cover imports, bulk operations, background consumers, administrative APIs, or direct repository calls.

## Source review checks

- The resource and tenant used by policy are the same values used by the protected effect.
- Server-owned decision inputs are derived after parsing and cannot be replaced by client fields.
- Missing identity, relationship, policy data, or evaluator availability resolves to deny.
- Errors and timeouts cannot reuse a previous allow decision or bypass the decision point.
- Cache keys include every mutable input that can change a decision, with bounded lifetime and explicit invalidation.
- Long-running jobs bind an immutable initiating actor, tenant, policy context, and authorization freshness rule.
- Service credentials do not silently replace end-user authority where the operation requires both.
- Administrative override and impersonation are separate, constrained decisions with attributable evidence.

## Policy lifecycle checks

Identify rule ownership, review, tests, deployment identity, version, rollback, and emergency override. Verify that enforcement consumers can reject unknown or incompatible policy versions. Compare declarative policy with wrapper defaults and adapter behavior.

## Evidence standard

Keep source locations, configuration digests, representative decision tuples, and reachable call paths. Distinguish a demonstrated missing decision, a mismatched decision input, a stale decision, and an operational governance weakness; they require different remediation and confirmation.
