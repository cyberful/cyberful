# Object Reconstruction Proof

## Boundary inventory

Record format, parser and version, entry API, configuration, schema, type metadata, allowlist or binder, object factory, constructors, setters, callbacks, post-load hooks, and downstream consumers. Include nested, collection, reference, and second-order reconstruction.

## Safe progression

1. Prove attacker influence over a field or discriminator.
2. Prove selection of an unexpected but harmless type or property.
3. Prove a controlled in-memory or loopback-visible marker effect.
4. Stop before filesystem persistence, command execution, external network traffic, credential access, or destructive state.

## Remediation evidence

Prefer data-only formats, closed schemas, explicit type registries, primitive DTOs, immutable binding targets, construction after validation, and disabled dangerous callbacks. Version upgrades matter only when tied to the reachable configuration and path.

