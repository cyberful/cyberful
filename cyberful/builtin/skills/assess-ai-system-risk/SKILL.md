---
name: assess-ai-system-risk
description: Assess AI-system risk from architecture, intended use, affected actors, model limitations, data lineage, autonomy, human oversight, monitoring, and failure consequences. Use for evidence-based NIST AI RMF-aligned posture reviews, design decisions, control gaps, and residual-risk prioritization without active exploitation.
metadata:
  domain: ai-security
  subdomain: risk-assessment
  triggers:
    - AI system risk assessment
    - NIST AI RMF review
    - AI control posture
    - model risk register
    - agent architecture risk
  tags:
    - AI-risk
    - NIST-AI-RMF
    - governance
    - impact-assessment
    - human-oversight
    - residual-risk
  frameworks:
    nist_ai_rmf:
      - GOVERN 1.3
      - MAP 1.1
      - MEASURE 1.1
      - MANAGE 1.1
---

# Assess AI System Risk

Assess the implemented socio-technical system, not the model in isolation. Keep facts, assumptions, test evidence, and policy claims distinct.

## Establish context and consequences

Map intended and foreseeable use, affected actors, decision criticality, autonomy, reversibility, data sensitivity, model and provider routes, retrieval/memory, tools, human oversight, deployment environments, and incident ownership. Start from unacceptable outcomes and trace the capabilities and conditions required for each.

Copy [assets/ai-risk-register.template.json](assets/ai-risk-register.template.json) into the workarea. Read [references/risk-evidence-method.md](references/risk-evidence-method.md) before assigning likelihood, consequence, or confidence.

## Reconcile controls and evidence

Evaluate governance, provenance, data quality, evaluation coverage, identity and authorization, isolation, output handling, monitoring, fallback, change management, incident response, recovery, and retirement. Route concrete tests to the relevant `audit-`, `trace-`, or `test-` skill; do not infer technical effectiveness from policy text.

## Deliver

Produce scoped risks tied to assets and affected actors, evidence grade, existing controls, control owner, uncertainty, treatment decision, validation plan, residual risk, and review trigger. Avoid a single opaque score when likelihood or consequence depends on deployment conditions.
