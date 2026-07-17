# Supply Chain Fieldbook

## Inventory blind spots

- statically linked native libraries without package metadata;
- shaded JARs and repackaged assemblies;
- vendored or copied source;
- browser bundles and source maps;
- language plugins loaded by filename or reflection;
- packages restored during startup;
- optional/peer dependencies activated only in production;
- build tools executed on untrusted source or assets;
- firmware, WASM, model, ruleset, and signature artifacts;
- deleted secrets or packages retained in image layers.

## Reconciliation order

1. Confirm artifact digest and target architecture.
2. Compare package coordinates and locations, not display names alone.
3. Identify whether the scanner inferred a version from metadata, filename, binary fingerprint, or distro database.
4. Check epoch, revision, distro backport, and vendor advisory semantics.
5. Re-run both vulnerability engines over the same SBOM.
6. Inspect the affected symbol or feature and runtime loading path.
7. Record database age and withdrawn/rejected advisory status.

## High-leverage findings

- mutable CI action/container tags in privileged workflows;
- unpinned installers or checksum-free release downloads;
- dependency confusion across public/private namespaces;
- lockfile bypass, platform-dependent resolution, or lifecycle scripts;
- release signing keys available to ordinary CI jobs;
- provenance attestation detached from the shipped digest;
- package registry credentials exposed to pull-request code;
- update agents with broader authority than the application;
- SBOM generated from source rather than the released artifact;
- an allowlisted package capable of loading attacker-controlled plugins.

## False-negative traps

Sparse checkouts, ignored submodules, private registries, offline vulnerability DBs, wrong architecture, image index versus platform manifest, distroless packages, deleted layers, encrypted archives, generated binaries, monorepo workspace pruning, and scanner size/time limits.

## Evidence grading

- **Inventory-confirmed:** component and version exist in the exact artifact.
- **Affected-code-confirmed:** vulnerable code or feature exists.
- **Reachability-supported:** production control/data flow can reach it.
- **Exploit-condition-confirmed:** attacker control and required configuration hold.
- **Impact-demonstrated:** bounded proof shows the security consequence.

Do not merge these grades into one binary vulnerable/not-vulnerable label.
