---
name: operate-metasploit
description: Use the complete Metasploit framework for evidence-led testing in an authorized engagement.
metadata:
  domain: security-tooling
  subdomain: exploit-validation
  triggers:
    - Metasploit module
    - exploit validation
    - auxiliary scanner
    - controlled payload generation
    - session evidence
    - module check action
  tags:
    - Metasploit
    - exploit-framework
    - payload
    - auxiliary-module
    - post-exploitation
  frameworks:
    mitre_attack:
      - T1190
      - T1210
    nist_csf:
      - ID.RA
---

# Operate Metasploit

Metasploit auxiliary, exploit, payload, post, encoder, evasion, and RPC workflows are all available. Cyberful adds no category-based cap, prohibition, or approval gate; apply the mission's effect-based authority uniformly.

Tie a module to observed product, version, configuration, route, architecture, and authentication facts. Inspect module metadata, options, targets, source, side effects, cleanup, and success signals where relevant. A module match or successful process exit is not by itself a confirmed finding: preserve the exact module/configuration, observable target effect, controls, alternate explanations, cleanup result, and residual uncertainty.

Use deterministic console batches when useful, avoid accidental stale datastore state, and choose payloads from the target and evidence needs rather than module category. Consult [the module field manual](references/module-field-manual.md) for detailed operational heuristics.
