# Serverless boundary method

## Event tuple

Record `producer -> transport/resource policy -> event envelope -> filter -> function version -> execution identity -> tenant/actor derivation -> destinations -> retry/dead-letter path`. Preserve provider-generated and application-controlled fields separately.

## Review conditions

- Invocation policy binds the expected service, account, resource, stage, and source identity.
- The handler derives authorization context from authenticated bindings rather than mutable payload fields.
- Function authority is narrower than the maximum effect of attacker-controlled event fields.
- Idempotency and replay controls survive duplicate, delayed, reordered, and partially processed events.
- Failure destinations, logs, traces, temporary files, and environment state do not expose secrets or cross tenants.
- Versions, aliases, layers, extensions, and deployment packages are immutable and promoted through controlled identities.

An error response or failed invocation is not an impact. Identify the accepted event, resulting authority, and protected state transition.
