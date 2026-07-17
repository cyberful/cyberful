---
name: operate-supply-chain-toolchain
description: Operate Syft, Grype, Trivy, Gitleaks, Retire.js, package-manager metadata, and build evidence for advanced software-supply-chain assessment. Use for SBOM construction, dependency reconciliation, image and filesystem analysis, secret-history review, vulnerability triage, provenance gaps, release-diff analysis, and separating package presence from reachable exploitability.
---

# Operate Supply Chain Toolchain

Build an evidence graph from source declaration to lock resolution, restored artifact, build stage, runtime image, loaded component, advisory match, and reachable behavior. Scanner counts are intermediate data, not conclusions.

## Establish artifact identity

Record commit and submodules, lockfiles, package-manager versions, build arguments, target platform, base-image digest, image digest, registry, SBOM format/schema, scanner versions, vulnerability database timestamps, ignore policy, and collection time.

Scan source trees, build outputs, container images, and deployed artifacts separately. A multistage build can remove build dependencies; vendoring, shading, static linking, plugins, or runtime downloads can add components absent from manifests.

## Build and reconcile inventories

1. Generate a canonical SBOM with Syft using package and file catalogers appropriate to the artifact.
2. Generate independent Trivy inventory/vulnerability output.
3. Scan the canonical SBOM with Grype so inventory drift is not confused with advisory drift.
4. Use Retire.js for shipped browser bundles and vendored JavaScript that package manifests miss.
5. Diff inventories by package URL, coordinates, version, location, layer, and evidence source.

Read [references/supply-chain-fieldbook.md](references/supply-chain-fieldbook.md) for reconciliation and high-value edge cases.

## Triage vulnerabilities as hypotheses

For each candidate, establish package identity, installed versus upstream version semantics, distro backports, affected component/function, reachable entry point, attacker influence, runtime privilege, mitigating configuration, deployment exposure, and fixed-version feasibility.

Do not dismiss a finding solely because the application does not import the package directly; transitive loaders, framework auto-discovery, native linkage, and tooling invoked in CI can create reachability.

## Separate secret surfaces

Run Gitleaks against current content and repository history with explicit configuration and stable output. Classify each result as live credential, revoked credential, test fixture, high-entropy non-secret, encrypted material, or unresolved. Validate only with non-mutating identity/introspection calls when appropriate; never print full values into reports.

Search build logs, image layers, package registry configuration, CI definitions, generated source maps, debug artifacts, and release bundles. Deleting a file in a later container layer does not remove it from earlier layers.

## Deliver

Preserve raw SBOMs, scanner/database identity, manifest-to-runtime diffs, secret scope and provenance, triage rationale, suppressed items, unscanned artifact classes, and remediation ordered by reachable impact and supply-chain leverage. Keep inventory confidence distinct from vulnerability confidence.
