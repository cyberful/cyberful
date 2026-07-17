# CI, Build, Artifact, and Provenance Review

## Trigger and Permission Matrix

For each workflow, record event, actor trust, checked-out revision, token permissions, secrets, cloud identity, network, runner persistence, environment approvals, and artifact consumers.

Pay special attention to workflows that combine privileged context with untrusted checkout or metadata, scheduled builds that consume mutable branches, and comment-driven automation.

## Injection and Path Control

Trace expressions and metadata into:

- shell or interpreter command text;
- generated scripts and configuration;
- filesystem paths, archives, and artifact names;
- cache keys and restore prefixes;
- container tags and build arguments;
- release notes and deployment parameters;
- remote URLs and package coordinates.

Use structured arguments or environment passing where possible; quoting a templated shell fragment is fragile across shells and nested interpreters.

## Runner and Cache Isolation

Review self-hosted runner persistence, workspace cleanup, Docker socket or host mounts, cloud metadata, credential helpers, SSH agents, tool caches, package caches, and artifacts from untrusted jobs. A cache is an input channel and needs writer isolation, key specificity, and content verification.

## Artifact Integrity

Bind artifacts to source revision and builder identity with immutable digests and verifiable attestations. Promote the exact tested digest. Restrict registry mutation and deletion. Verify signatures against an identity and policy, not merely cryptographic validity.

## High-Value Chain Hints

- An untrusted job cannot read secrets directly but can poison a cache later restored by a privileged job.
- Artifact extraction can traverse paths or replace scripts in a subsequent job.
- Workflow outputs and environment files are command channels if untrusted text can inject new lines or delimiters.
- Deployment approval may protect an environment while the artifact tag remains replaceable after approval.
- A pull-request build can publish an image under a tag later consumed by production.
- OIDC cloud credentials are short-lived but dangerous when audience, subject, repository, ref, workflow, or environment claims are weakly constrained.
- Release signing on a persistent runner may sign artifacts not produced by the reviewed source.
