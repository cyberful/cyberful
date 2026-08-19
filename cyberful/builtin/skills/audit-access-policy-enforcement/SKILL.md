---
name: audit-access-policy-enforcement
description: Audit where access policy is decided and enforced across source, configuration, services, caches, jobs, and data stores, including deny behavior and decision-input integrity.
metadata:
  domain: identity-security
  subdomain: access-policy
  triggers:
    - access policy audit
    - authorization enforcement review
    - policy decision point
    - policy enforcement point
    - default deny analysis
    - entitlement evaluation
  tags:
    - authorization
    - policy-engine
    - access-control
    - default-deny
    - entitlement
    - code-audit
  frameworks:
    nist_csf:
      - PR.AA-05
---

# Audit Access Policy Enforcement

Trace a protected operation from entry point through decision inputs, policy evaluation, enforcement, resource access, side effects, and audit evidence. Use this skill for source and configuration review; use `test-authorization-boundaries` to exercise a scoped live matrix.

## Build the decision ledger

Copy [assets/policy-decision-ledger.csv](assets/policy-decision-ledger.csv). Record the actor, subject, tenant, resource, relationship, action, state, assurance, environment, policy source, decision point, enforcement point, cache, and durable effect for every material operation.

Read [references/policy-enforcement-review.md](references/policy-enforcement-review.md) before auditing a shared policy engine, delegated administration, or asynchronous path.

## Trace enforcement

Start from routes, resolvers, handlers, consumers, scheduled jobs, and administrative entry points. Follow normalization and identity context into policy calls, then continue beyond the allow result to repository, storage, queue, notification, export, or external-service effects.

Compare sibling operations and alternate transports. Check middleware exclusions, direct repository use, bulk and relationship endpoints, cache keys, default and error branches, stale entitlements, impersonation, service credentials, and replayed jobs. Prove whether a missing, malformed, stale, or contradictory decision input fails closed.

## Evaluate policy integrity

Determine who can author, approve, deploy, override, and observe policy. Check rule precedence, deny overrides, version pinning, rollback, test coverage, data dependencies, and whether policy changes invalidate cached decisions and long-lived work.

## Report evidence

For each gap state the entry point, decision tuple, expected rule, actual code or configuration path, resource effect, alternate paths sharing the weakness, and the evidence needed for confirmation. Do not label dead code, a missing UI check, or a theoretical policy ambiguity as exploitable without a reachable server-side effect.

Code Audit remains read-only and offline. Do not alter policies, entitlements, identities, or production configuration while validating source conclusions.
