---
name: assess-tls-toolchain
description: Operate testssl.sh, sslscan, OpenSSL, Nmap TLS scripts, and direct protocol probes for advanced transport-security assessment. Use when mapping TLS listeners, certificate paths, SNI or ALPN behavior, client authentication, protocol and cipher policy, resumption, proxy termination, scanner disagreement, or transport findings that require endpoint-specific proof.
---

# Assess TLS Toolchain

Treat a TLS result as a property of a precise tuple: vantage point, IP, port, hostname/SNI, ALPN, protocol, client capabilities, and time. A scan against an IP without the production SNI is often evidence about the wrong virtual service.

## Build the endpoint matrix

Enumerate every externally and internally relevant listener, alternate port, load balancer, origin, ingress, mail or database protocol, IPv4/IPv6 path, and CDN edge. Record DNS resolution, redirect path, proxy chain, SNI, advertised ALPN, and whether the connection reaches an edge or origin.

Probe each materially different tuple. Sample multiple edges when policy may vary by region or deployment cohort.

## Layer the tools

1. Use testssl.sh for broad protocol, cipher, certificate, extension, vulnerability, and HTTP-header coverage.
2. Use sslscan to independently enumerate negotiation behavior.
3. Use OpenSSL or a minimal client for exact SNI, ALPN, certificate-path, resumption, renegotiation, and client-certificate experiments.
4. Use Nmap TLS scripts only as another vantage and fingerprint source, not as the deciding oracle.

Read [references/tls-fieldbook.md](references/tls-fieldbook.md) before resolving disagreement or reporting a chain problem.

## Separate control planes

Analyze independently:

- protocol versions and downgrade surface;
- cipher/key-exchange policy and server preference;
- certificate identity, path building, constraints, name constraints, revocation, and expiry;
- TLS extensions, compression, renegotiation, resumption, 0-RTT, and client authentication;
- application headers and cookie policy returned after TLS;
- origin exposure or edge/origin policy divergence.

Do not collapse these into one "TLS grade." A strong edge configuration does not compensate for a directly reachable weak origin.

## Reconcile negatives

When a tool reports absence, check whether it lacked SNI, selected a different ALPN, stopped after a handshake alert, could not build a private chain, was rate-limited, tested only TLS-over-TCP, or reached a mutually authenticated listener. Compare offered and negotiated parameters with a direct probe.

For intermittent results, preserve the resolved IP and repeat against the same edge before attributing drift.

## Deliver proof

Preserve commands, tool versions, timestamps, endpoint tuples, raw handshakes, certificate chain in presented order, negotiated parameters, and the smallest reproducible client command. State whether the consequence affects confidentiality, authentication, downgrade resistance, client compatibility, or only policy hygiene.
