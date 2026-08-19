---
name: audit-software-supply-chain
description: Coordinate an authorized software-supply-chain audit from dependency resolution through build, artifact, release, deployment, and runtime trust. Use when several producer-to-runtime controls need one evidence model; use a narrower specialist for one pipeline, artifact, secret, infrastructure, or release mechanism.
metadata:
  domain: software-supply-chain
  subdomain: producer-to-runtime-assurance
  triggers:
    - software supply chain audit
    - dependency provenance review
    - build pipeline trust
    - artifact integrity audit
    - release provenance
    - dependency confusion review
  tags:
    - SBOM
    - SLSA
    - provenance
    - CI-CD
    - dependency-confusion
    - artifact-signing
  frameworks:
    mitre_attack:
      - T1195
    nist_csf:
      - GV.SC
      - ID.RA
      - PR.PS
---

# Audit the Software Supply Chain

Own the end-to-end trust model and route concrete analysis to specialists.

## Build the shared chain

Map `source commit -> dependency resolution -> generated inputs -> build identity -> cache -> artifact -> registry -> attestation -> promotion -> deployment -> runtime`. For every edge, record who can write, which identity authorizes it, how bytes are selected, and which evidence binds input to output.

Read [references/dependency-resolution.md](references/dependency-resolution.md) to inventory ecosystem authority and [references/ci-build-provenance.md](references/ci-build-provenance.md) to define the shared producer-to-runtime ledger.

## Route the mechanisms

- Native SBOM, vulnerability, image, and secret evidence: `operate-supply-chain-toolchain`.
- Infrastructure definitions and plans: `audit-infrastructure-as-code`.
- CI, build, promotion, and release controls: `audit-build-release-pipelines`.
- Model, dataset, adapter, and ML artifact provenance: `audit-ai-model-supply-chain`.
- Secret custody and broker policy: `audit-secrets-management`.
- Commit-to-release security deltas: `analyze-release-security-diff`.
- Container and orchestration enforcement: `audit-container-runtime-isolation` and `audit-kubernetes-policy-enforcement`.

Do not repeat scanner, pipeline, IaC, or secret-review procedures here.

## Reconcile evidence

Keep declaration, resolution, build inclusion, shipped presence, runtime loading, advisory applicability, and exploit reachability as separate evidence grades. Require artifact digests, tool/database versions, identity context, policy source, negative controls, and unavailable stages from every specialist.

Confirm a finding only when an untrusted or insufficiently authenticated input can alter a trusted dependency, build, release, deployment, or runtime result. Deduplicate by compromised trust edge and authority owner. Deliver the chain map, coverage ledger, confirmed breaks, unsupported assumptions, systemic leverage, remediation owner, regression proof, and residual blind spots.
