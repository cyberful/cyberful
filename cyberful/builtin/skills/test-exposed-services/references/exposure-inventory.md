# Exposure Inventory and Ownership

## Correlation Sources

Combine:

- forward and reverse DNS, passive history, zone exports, and certificate names;
- CDN, load balancer, WAF, gateway, and ingress configuration;
- cloud asset inventory, firewall rules, public IPs, and service endpoints;
- Kubernetes services and ingresses, service mesh, and discovery;
- source code, environment files, deployment outputs, mobile apps, and client bundles;
- email, SSO, webhook, OAuth, and SaaS custom-domain configuration;
- monitoring, status pages, documentation, and support portals.

A hostname absent from the current web app may still be a privileged callback, origin, or administration path.

## Ownership Resolution

Assign every asset an environment, team, provider account, deployment source, data classification, and retirement state. Unknown ownership is an operational risk but becomes a vulnerability only when paired with a reachable security-relevant capability.

## Origin and Gateway Bypass

Compare direct origin behavior with CDN or gateway behavior for authentication, WAF rules, rate limits, headers, routing, client certificates, and host allowlists. Check whether origin addressing is exposed through DNS history, certificates, email headers, error pages, source maps, or provider metadata.

## Takeover Analysis

Prove the full chain:

1. controlled DNS name points to a third-party resource namespace;
2. referenced resource is absent or detached;
3. provider permits a different account to claim the exact binding;
4. domain verification or account ownership does not prevent claim;
5. claimed service would receive relevant traffic or trust.

Provider error pages and claim semantics change. Base the conclusion on current observable behavior or configuration evidence.

## High-Yield Hints

- Preview environments outlive branches and retain production SSO trust.
- IPv6 listeners bypass IPv4-only firewalls or monitoring.
- Internal names resolve publicly through split-horizon mistakes.
- Health and metrics paths expose build, queue, tenant, or credential metadata despite protected primary routes.
- A retired hostname remains trusted in CORS, OAuth, CSP, cookies, or signed-link allowlists after service deletion.
- Direct cloud-provider hostnames can bypass custom-domain protections.
