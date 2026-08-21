---
name: analyze-fraud-control-evidence
description: Normalize and compare authorized fraud-control observations from local evidence, highlighting decision drift, coverage gaps, and conflicting outcomes without making a fraud or vulnerability verdict.
metadata:
  domain: application-security
  subdomain: fraud-control-evidence
  triggers:
    - fraud control evidence analysis
    - risk decision comparison
    - fraud decision drift
    - control reason code analysis
    - anti-fraud evidence ledger
    - fraud control coverage
  tags:
    - fraud
    - control-evidence
    - decision-analysis
    - reason-codes
    - offline-analysis
  frameworks:
    nist_csf:
      - DE.AE-02
      - DE.AE-03
---

# Analyze Fraud Control Evidence

Turn already-collected, authorized decision artifacts into a deterministic comparison ledger. Analyze control behavior and evidence quality; do not infer an actor's intent, label a customer as fraudulent, or promote a mismatch directly into a vulnerability finding.

## Prepare observations

Read [references/control-evidence.md](references/control-evidence.md) before combining decisions from different policy versions, channels, or enforcement points. One observation must identify the scenario, control, lifecycle stage, actor, channel, expected and observed decision, reason codes, signal references, durable effect, and authoritative evidence reference. Use pseudonymous or synthetic identifiers.

Copy [assets/fraud-control-observations.example.json](assets/fraud-control-observations.example.json) and preserve [assets/fraud-control-observations.schema.json](assets/fraud-control-observations.schema.json). The input is a local evidence index, not raw customer data or credentials.

## Normalize deterministically

Run [scripts/run_fraud_control_analysis.py](scripts/run_fraud_control_analysis.py) in the workarea. The offline analyzer validates and sorts observations, counts stage and decision coverage, records expected-versus-observed comparisons, and identifies conflicting decisions for the same scenario and control. Its bounded raw output follows [assets/fraud-control-analysis.schema.json](assets/fraud-control-analysis.schema.json).

## Interpret with control context

Reconcile mismatches against policy version, signal freshness, experiment assignment, review queues, fail-open behavior, and downstream enforcement. A challenge, denial, or review decision is not proof that value movement was prevented; a nominal allow is not proof of abuse. Link decision evidence to authoritative state or ledger effects before reporting impact.
