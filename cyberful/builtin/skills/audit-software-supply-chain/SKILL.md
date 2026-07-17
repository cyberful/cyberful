---
name: audit-software-supply-chain
description: Audit dependency resolution, package provenance, build systems, CI/CD workflows, artifacts, registries, signing, release promotion, and deployment trust during authorized code audits and security assessments. Use for dependency confusion, typosquatting, malicious install scripts, lockfile drift, CI injection, poisoned caches, artifact substitution, secret exposure, untrusted contributions, SBOM, provenance, and release-integrity review.
---

# Audit the Software Supply Chain

## Model the Producer-to-Runtime Chain

Trace source commit, dependency resolution, code generation, build runner, cache, artifact, registry, signature or attestation, release promotion, deployment controller, and runtime image. At each edge, identify who can write, what identity is trusted, how bytes are selected, and what evidence binds input to output.

The central question is not whether a scanner reports vulnerable packages. Determine whether untrusted or insufficiently authenticated input can become a trusted build, release, or runtime artifact.

Read [dependency-resolution.md](references/dependency-resolution.md) for ecosystem and package risk. Read [ci-build-provenance.md](references/ci-build-provenance.md) for automation, artifact, and release trust.

## Inventory Dependency Authority

For every ecosystem and toolchain, record:

- manifest and lockfile;
- public, private, mirror, proxy, and local registries;
- source, binary, VCS, path, plugin, action, image, and tool dependencies;
- namespace ownership and precedence;
- integrity hashes, signatures, and provenance;
- lifecycle scripts and code generation;
- update bots and review policy;
- vendored, generated, patched, or dynamically downloaded components.

Resolve what the production build actually selects under its network, credentials, and configuration. A manifest-only inventory misses implicit plugins and bootstrap downloads.

## Analyze CI Trust Transitions

Classify triggers by contributor trust and secret availability. Follow untrusted branch names, commit messages, issue text, PR metadata, filenames, artifact names, matrices, workflow outputs, and generated scripts into shell, expression, path, cache, and deployment sinks.

Review reusable workflows and composite actions as code with caller/callee permission boundaries. Pin third-party automation to immutable identities where practical and inspect transitive behavior.

## Verify Artifact Continuity

Determine whether the artifact tested is the artifact promoted. Record digests at build, scan, sign, registry, deployment, and runtime. Validate provenance subject, builder identity, source revision, parameters, and dependency material.

Rebuilding after approval, using mutable tags, or copying through an untrusted registry breaks continuity even if every individual stage is authenticated.

## Report the Trust Break

Document attacker-controlled input, resolving or executing component, credentials and network available there, resulting artifact or release capability, and the missing binding. Recommend hermetic or constrained builds, immutable resolution, least-privilege automation, isolated untrusted jobs, digest promotion, and verifiable provenance.
