---
name: test-exposed-services
description: Assess externally or internally reachable services, administrative planes, debug interfaces, data stores, search clusters, object storage, orphaned DNS, and deployment exposure during authorized penetration tests or code audits. Use for unintended service exposure, subdomain takeover, Elasticsearch or database access, admin consoles, debug endpoints, default deployments, cloud buckets, management APIs, and network-boundary validation.
---

# Test Exposed Services

## Build an Exposure Graph

Correlate DNS, certificates, network listeners, reverse-proxy routes, service discovery, cloud inventory, infrastructure code, deployment manifests, application links, source configuration, and historical names. Represent each service as owner, environment, network reach, protocol, authentication, tenant context, data or action capability, and lifecycle status.

Do not stop at an open port. Identify the deployed product or custom protocol, access path, security boundary, and business impact.

Read [exposure-inventory.md](references/exposure-inventory.md) for discovery and ownership. Read [datastores-admin.md](references/datastores-admin.md) for management and data-plane review.

## Validate Reach and Boundary

For each candidate:

1. confirm DNS and network reach from the relevant attacker position;
2. identify TLS identity, virtual host, protocol, and product without disruptive probing;
3. test whether authentication is required and enforced on every capability;
4. distinguish anonymous metadata from data read, data write, code execution, or control-plane action;
5. correlate with intended architecture and environment.

Check alternate ports, hostnames, IPv6, direct origin IPs, legacy protocols, health routes, metrics, debug handlers, and management interfaces that bypass the public gateway.

## Test Lifecycle Failures

Trace decommissioning of domains, cloud resources, SaaS custom domains, storage, load balancers, and preview environments. For takeover candidates, establish that the external provider resource is unclaimed and bindable under the current provider behavior. A dangling DNS record alone is a candidate, not proof.

## Review Data Services

For search, database, cache, queue, registry, storage, and observability services, evaluate anonymous access, network ACLs, authentication, tenant isolation, dangerous administrative APIs, script or plugin capabilities, snapshot and backup access, and credential reuse.

Use read-only metadata or tester-owned records for confirmation when they prove the boundary. Record whether the exposed service trusts source network or proxy-injected identity.

## Report Capability, Not Banner

Document reachable path, service identity, authentication and authorization state, exposed capability, data classification, environmental role, and ownership. Separate inventory hygiene, information disclosure, data-plane compromise, and control-plane compromise.
