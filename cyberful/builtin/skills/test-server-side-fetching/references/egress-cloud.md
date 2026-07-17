# Egress, Cloud, and Internal Reach

## Network Containment

Prefer a dedicated fetch service with:

- explicit destination allowlists where business semantics permit;
- deny-by-default network egress;
- no route to management, control-plane, metadata, loopback, or workload-internal networks;
- DNS through a policy-aware resolver;
- request and response size, time, recursion, and concurrency limits;
- no ambient credentials;
- normalized audit logs with secret redaction.

Application URL validation and network egress controls should both exist because either can drift.

## Cloud and Orchestrator Context

Identify provider metadata services, workload identity endpoints, instance and container APIs, service discovery, cluster control planes, serverless internal endpoints, local admin sockets, and mesh management interfaces. Determine whether session-oriented metadata protections or hop limits apply, but do not treat them as the sole SSRF defense.

## Internal Protocol Capability

Inventory client-supported protocols and proxy behavior: HTTP(S), local file access, FTP-like schemes, raw or gopher-like transports, Unix sockets, and custom handlers. Measure whether the attacker controls destination, bytes, headers, method, TLS SNI, client certificate, or response visibility.

These dimensions predict which internal services are reachable better than a generic payload list.

## Blind SSRF Signal Analysis

Separate:

- application DNS resolution;
- recursive resolver queries;
- security scanner or URL-reputation fetches;
- mail or chat unfurling;
- asynchronous job retries;
- origin application fetches.

Compare user agent, source network, header fingerprints, delay, and retry schedule. A callback from an unrelated scanner does not prove server-side reach from the protected workload.

## Chain Hints

- Signed webhook validation may occur after the callback fetch, leaving SSRF before authenticity rejection.
- PDF, image, and office renderers can turn a body-only fetch into recursive subresource access.
- Internal services often trust source network, forwarded identity, or default virtual hosts even when external services require tokens.
- Response truncation can still expose secrets through status, redirects, image dimensions, parser errors, or conditional callbacks.
