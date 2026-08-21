---
name: audit-ai-model-supply-chain
description: Audit local AI model, adapter, tokenizer, configuration, and packaging artifacts for provenance, integrity, dependency, serialization, license, and loading-risk evidence. Use when model bytes or manifests must be traced from source and registry identity to the exact deployed artifact without network retrieval.
metadata:
  domain: ai-security
  subdomain: model-supply-chain
  triggers:
    - AI model supply chain audit
    - model artifact provenance
    - adapter integrity review
    - tokenizer supply chain
    - unsafe model serialization
  tags:
    - model-artifacts
    - provenance
    - safetensors
    - pickle
    - adapters
    - artifact-integrity
  frameworks:
    mitre_attack:
      - T1195
    nist_csf:
      - GV.SC
      - PR.PS
    nist_ai_rmf:
      - MAP 4.1
---

# Audit AI Model Supply Chain

Trace the exact bytes selected by the runtime. A registry name, model card, or checksum copied from the same untrusted source is not provenance.

## Build the artifact chain

Record source, immutable revision, publisher identity, transfer path, digest, signature or attestation, format, loader, tokenizer, adapters, quantization, configuration, code-trust flags, native extensions, licenses, and deployment selection logic. Read [references/model-artifact-provenance.md](references/model-artifact-provenance.md) for format-specific hazards.

For repeatable local collection, stage [scripts/run_model_supply_chain_campaign.py](scripts/run_model_supply_chain_campaign.py), its [manifest](scripts/manifest.json), and the [campaign example](assets/model-supply-chain-campaign.example.json). The orchestrator uses a fixed Syft command, never updates or retrieves artifacts, and preserves bounded raw output.

## Confirm trust breaks

Distinguish declared provenance, verified integrity, build inclusion, deployed selection, and runtime loading. Confirm only a path by which insufficiently authenticated bytes, executable serialization, untrusted remote code, mutable references, or adapter/tokenizer substitution can influence the deployed model behavior or host runtime.
