---
name: assess-fraud-abuse-model
description: Model fraud and abuse threats across actors, account states, value flows, controls, and monetization paths. Use when an engagement needs a scoped abuse model and coverage plan rather than active testing.
metadata:
  domain: application-security
  subdomain: fraud-abuse-modeling
  triggers:
    - fraud threat model
    - abuse case modeling
    - fraud actor analysis
    - monetization path analysis
    - fraud control coverage
    - F3 coverage assessment
  tags:
    - fraud
    - abuse-model
    - threat-modeling
    - value-flow
    - trust-boundary
    - MITRE-F3
  frameworks:
    nist_csf:
      - ID.RA-03
---

# Assess Fraud Abuse Model

Build a falsifiable model that connects permitted actors and starting states to protected value, trust transitions, fraud controls, and durable outcomes. This skill plans coverage; it does not authorize active transactions or treat a framework mapping as evidence.

## Bound the model

Record the engagement authorization, products, channels, geographies, tester identities, synthetic instruments, prohibited effects, and evidence sources. Distinguish customer harm, platform loss, merchant loss, regulatory exposure, and operational cost. Read [references/model-construction.md](references/model-construction.md) when the product spans multiple actors or value ledgers.

Copy [assets/fraud-abuse-model.template.json](assets/fraud-abuse-model.template.json) and preserve [assets/fraud-abuse-model.schema.json](assets/fraud-abuse-model.schema.json) when a durable model is needed. Replace every synthetic field and keep hypotheses separate from observed facts.

## Model paths and controls

Trace acquisition, enrollment, funding, authentication, account change, transaction initiation, authorization, execution, settlement, reversal, dispute, payout, recovery, and review where present. For each abuse path record prerequisites, controlled actor, target asset, trust-boundary crossings, product invariants, existing controls, expected evidence, monetization or benefit, and safe stopping conditions.

Use MITRE F3 as a coverage lens only when an abuse behavior genuinely matches a pinned technique. Preserve product-specific paths that have no framework equivalent. Route control artifacts to `analyze-fraud-control-evidence`, causal state to `trace-transaction-state`, and active mechanisms to the appropriate payment, entitlement, automation, authorization, or concurrency specialist.

## Produce a coverage decision

Prioritize paths by reachable value, control uncertainty, blast radius, reversibility, observability, and evidence quality. State what is covered, deferred, prohibited, or unknown. A model is complete enough when every high-value path has a named invariant, permitted test method, control owner, authoritative evidence source, and cleanup plan.
