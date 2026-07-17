---
name: audit-application-code
description: Execute a full white-box application security audit across architecture, source, configuration, dependencies, build and deployment paths. Use for repository-wide code audits, secure code review, security assessments, design-to-implementation verification, taint and authorization review, security test design, or when a diff-only review is insufficient.
---

# Audit Application Code

Audit the implemented security model, not isolated suspicious lines. Treat scanners and search patterns as indexing aids; independently establish reachability, trust boundaries, control placement, and impact.

## Define the audit contract

1. Establish repository, commit, components, environments, languages, generated code policy, and excluded assets.
2. Identify required assurance target: focused vulnerability hunt, ASVS verification, architectural review, release gate, or full product assessment.
3. Record available tests, build instructions, runtime configuration, deployment manifests, schemas, documentation, and production differences.
4. Separate audit findings from SDLC maturity observations.

## Map before hunting

Read [references/repository-mapping.md](references/repository-mapping.md) and produce:

- component and deployment inventory;
- entry-point and trust-boundary map;
- data classification and persistence map;
- identity, session, authorization, and tenant enforcement map;
- privileged operation and business-invariant inventory;
- external dependency, build, CI/CD, and secret-flow inventory.

Do not begin broad sink searches until the owning component and reachable entry points are known.

## Review in risk order

1. Security invariants and architectural assumptions.
2. Identity proofing, authentication, federation, session, and account lifecycle.
3. Authorization placement, tenant scoping, relationship checks, and privileged workflows.
4. Untrusted dataflows into interpreters, parsers, filesystems, templates, browsers, outbound requests, logs, and dynamic loading.
5. Secrets, cryptography, signing, randomness, sensitive-data copies, and retention.
6. Concurrency, retries, idempotency, state transitions, quotas, and resource amplification.
7. Dependency resolution, build scripts, CI authority, provenance, deployment and cloud configuration.
8. Language-runtime, framework, native-memory, mobile, and agentic-AI hazards when applicable.

Route deep work to the narrowest matching built-in skill. Use [references/language-patterns.md](references/language-patterns.md) only for languages detected in scope.

## Trace findings end to end

For dataflow findings, trace:

`attacker-controlled source -> normalization/transforms -> validation/authorization -> storage or propagation -> security-sensitive sink -> observable effect`

For control findings, trace:

`security requirement -> policy owner -> enforcement points -> bypass paths -> downstream authority -> audit and revocation behavior`

Inspect aliases, wrappers, callbacks, dependency injection, middleware ordering, generated clients, background workers, message consumers, batch paths, retries, and error fallbacks. Search both forward from sources and backward from sinks.

## Prove reachability and exploitability

Classify each candidate:

- `UNREACHABLE`: no production entry point reaches it under documented builds.
- `CONTROLLED`: reachable, but a correctly placed control dominates every path examined.
- `CONTEXT_DEPENDENT`: safety depends on deployment, caller, configuration, or data invariant not available in the audit.
- `VULNERABLE`: reachable attacker capability crosses a security boundary and produces a material effect.

Do not call dead code, test fixtures, privileged maintenance scripts, or safe constant construction vulnerable without a realistic activation path. Do not dismiss dangerous code solely because the current UI does not expose it when APIs, jobs, plugins, or alternate clients can.

Read [references/evidence-model.md](references/evidence-model.md) before finalizing findings.

## Validate controls negatively

For each critical control, inspect at least one expected-success and expected-denial path. Verify default-deny behavior, failure handling, revocation, stale caches, alternate channels, asynchronous paths, and tests that fail when the control is removed. Prefer a small regression test or non-destructive PoC when the repository can be executed safely.

## Deliver an auditable result

Produce:

1. Scope, commit and environmental assumptions.
2. Architecture and trust-boundary summary.
3. Coverage ledger by component and control family.
4. Confirmed findings with complete code paths and evidence.
5. Context-dependent and suspected issues with missing proof.
6. Controls reviewed with no issue observed, bounded to the paths examined.
7. Systemic root causes and representative affected sites.
8. Remediation architecture and regression tests.
9. Residual risk, inaccessible components, unbuilt paths, and deployment uncertainty.

## Authoritative anchors

- OWASP Code Review Guide: https://owasp.org/www-project-code-review-guide/
- OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
- CWE: https://cwe.mitre.org/
- NIST SSDF: https://csrc.nist.gov/pubs/sp/800/218/final
- SEI CERT Coding Standards: https://wiki.sei.cmu.edu/confluence/display/seccode
