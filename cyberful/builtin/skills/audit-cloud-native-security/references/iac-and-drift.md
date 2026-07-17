# Infrastructure as Code and Drift

## Provenance Chain

Trace module source, version, provider, variables, generated values, plan, approval, apply identity, state backend, outputs, deployment controller, and live resource. Pin modules and providers to immutable versions with integrity verification.

Treat plan files and state as sensitive artifacts. They can contain credentials, private endpoints, resource IDs, and values hidden from normal output.

## Static Review

Inspect:

- public exposure and default network rules;
- IAM wildcards, trust conditions, and pass-role edges;
- encryption and key ownership;
- logging and tamper resistance;
- secret injection;
- deletion protection and backup;
- metadata protections and workload identity;
- container and Kubernetes security contexts;
- lifecycle ignores and provider defaults;
- cross-account sharing and resource policies.

## Drift and Generated Configuration

Compare declared and live state. Account for console changes, imperative scripts, operators, autoscaling, policy inheritance, service defaults, imports, ignored attributes, and provider normalization.

## High-Yield Hints

- A secure module can be instantiated unsafely through variables or overridden providers.
- Conditional resource creation leaves an old permissive resource after the new secure path is enabled.
- `ignore_changes` can conceal security-critical drift.
- A plan reviewed in one identity or account can be applied in another.
- Remote-state read access creates a cross-project information boundary.
- Destroy/recreate behavior can temporarily drop policy, reuse names, or transfer external bindings.
