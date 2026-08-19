---
name: audit-build-release-pipelines
description: Audit build and release pipelines for identity separation, source-to-artifact integrity, provenance, approval, promotion, signing, rollback, and production deployment controls. Use for CI/CD workflow, runner, artifact, or release-governance review.
metadata:
  domain: software-supply-chain
  subdomain: build-release-pipelines
  triggers:
    - build pipeline security audit
    - release pipeline review
    - cicd deployment controls
    - artifact promotion security
    - build provenance audit
    - production approval bypass
  tags:
    - cicd
    - release-integrity
    - artifact-provenance
    - deployment-identity
    - approvals
    - signing
  frameworks:
    nist_csf:
      - PR.PS-06
      - GV.SC-07
---

# Audit Build and Release Pipelines

Follow one releasable artifact from reviewed source to production. Distinguish source authorization, build execution, artifact custody, promotion, deployment authorization, and rollback; a control at one boundary does not substitute for another.

## Build the release chain

Read [references/release-integrity-method.md](references/release-integrity-method.md). Populate [assets/release-control-ledger.example.json](assets/release-control-ledger.example.json) using [assets/release-control-ledger.schema.json](assets/release-control-ledger.schema.json) for each build, promotion, and deployment boundary. Record identities, mutable inputs, trust source, produced evidence, protected effect, and bypass path.

Review workflow definitions, reusable actions, runner placement, token claims, environment protections, artifact repositories, provenance/signature verification, manual approvals, and rollback identities. Resolve whether a production deployment consumes the exact artifact that was built and approved; matching names or versions are not identity proof.

## Confirm impact

Report a gap only when an actor can alter a protected source, build input, artifact, promotion decision, deployment target, or rollback outcome outside the intended authority. Preserve the shortest causal chain and distinguish a missing control from an exploitable path with reachable credentials and production effect.
