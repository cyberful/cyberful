# Data Stores and Administrative Planes

## Capability Ladder

Classify observed access:

1. product and version metadata;
2. schema, index, topic, bucket, or database enumeration;
3. data read;
4. data write or deletion;
5. configuration or user administration;
6. snapshot, backup, plugin, script, job, or code execution;
7. control-plane credential or cross-service pivot.

Report the highest confirmed capability and the prerequisites for the next step.

## Search and Analytics Services

Review cluster and node APIs, index aliases, document read/write, query scripting, snapshots, ingest pipelines, stored scripts, cross-cluster features, dashboards, and tenant separation. Product version changes which APIs are available; inspect actual deployment rather than relying on a fixed exploit list.

## Databases, Caches, Queues, and Registries

Evaluate authentication, transport, ACL granularity, default databases or namespaces, replication, administrative commands, module or extension loading, persistence, queue publish/consume boundaries, registry push/delete, and snapshot locations.

## Admin and Debug Interfaces

Look for framework consoles, profilers, heap or thread dumps, environment viewers, actuator endpoints, metrics, tracing UIs, job dashboards, feature-flag consoles, GraphQL explorers, API docs, and support impersonation.

Debug data can contain live tokens and secrets even when the interface cannot directly execute commands.

## False-Negative Traps

- Authentication exists on the UI but not the backing API.
- A service denies root paths yet exposes alternate namespaces, protocol verbs, or bulk endpoints.
- Private listeners become reachable through SSRF, mesh ingress, VPN split tunneling, or a public proxy.
- Read-only credentials can invoke server-side scripts, exports, snapshots, or callbacks.
- Cloud storage blocks listing but permits predictable-object read, version read, write, or metadata modification.
- A data service's own auth is bypassed because a gateway injects identity headers accepted from direct clients.
