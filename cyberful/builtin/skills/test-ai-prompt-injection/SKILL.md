---
name: test-ai-prompt-injection
description: Test whether authorized direct or indirect untrusted content can alter an AI system's protected behavior, context use, memory, retrieval, output handling, or downstream capability. Use for bounded prompt-injection experiments with benign markers and deterministic control comparisons.
metadata:
  domain: ai-security
  subdomain: prompt-injection
  triggers:
    - test AI prompt injection
    - indirect prompt injection
    - stored prompt injection
    - tool output injection
    - multimodal instruction injection
  tags:
    - prompt-injection
    - LLM
    - indirect-injection
    - canary
    - untrusted-content
    - control-comparison
  frameworks:
    mitre_atlas:
      - AML.T0051
    nist_ai_rmf:
      - MEASURE 2.7
---

# Test AI Prompt Injection

Demonstrate a failed boundary and consequential effect, not merely surprising text.

## Define the discriminator

For each source, specify protected instruction, untrusted channel, benign unique marker, expected safe behavior, control input, target capability, maximum effect, and cleanup. Read [references/prompt-injection-evidence.md](references/prompt-injection-evidence.md) before escalating beyond instruction influence.

Stage [scripts/run_prompt_injection_probe.py](scripts/run_prompt_injection_probe.py), its [manifest](scripts/manifest.json), and the [probe example](assets/prompt-injection-probe.example.json) for bounded HTTP comparisons. The JSON records defense-in-depth campaign constraints, never authority. Cyberful's mission-bound gateway or ZAP route supplies the actual authorization boundary, standard proxy and CA environment, and the only path to non-loopback targets. Responses are cumulative-bounded and environment secrets are redacted before evidence is retained.

## Confirm and report

Compare control and candidate across model route, retrieved context, tool request, canonical arguments, memory mutation, output consumer, and external effect. Stop at the smallest permitted proof. Record source, transformations, preconditions, model/tool path, failed deterministic control, reproducibility, and cleanup.
