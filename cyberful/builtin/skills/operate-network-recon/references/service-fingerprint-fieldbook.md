# Service Fingerprint Fieldbook

## Service identity hierarchy

Use the strongest available layer:

1. transport behavior;
2. protocol negotiation and feature bits;
3. authenticated capabilities;
4. product-specific semantics;
5. version/build evidence;
6. deployment configuration.

Banners are hints. Backports, proxies, honeypots, compatibility layers, and vendor forks routinely decouple banners from code.

## High-yield differentials

- TCP connect versus SYN scan: different middlebox and host policy paths.
- IPv4 versus IPv6: separate ACLs and listeners.
- hostname versus address: DNS steering, SNI, Host, Kerberos/SPN, virtual services.
- source network/interface: segmentation and policy routing.
- plaintext, STARTTLS, implicit TLS: distinct daemons/configuration.
- unauthenticated versus low-privilege authenticated capability enumeration.
- first connection versus reused/parallel connections: rate gates and connection proxies.
- UDP empty payload versus protocol-valid payload: closed/filtered ambiguity.

## UDP methodology

UDP negatives are expensive and ambiguous. Use:

- protocol-correct probes;
- sufficient retries and timeout;
- ICMP unreachable capture;
- small prioritized service set before broad range;
- native client confirmation;
- application response semantics.

An open|filtered port is a queue for stronger probes, not an open service.

## TLS and virtual services

The certificate, negotiated ALPN, server behavior, and application response can each come from a different layer. Record:

- connect address and port;
- SNI;
- Host/authority;
- ALPN and protocol version;
- certificate chain and names;
- redirect/canonical host;
- backend/caching markers.

Testing an IP without the intended SNI can fingerprint the provider default rather than the target service.

## Version detection traps

- tcpwrapped can mean access control, connection quota, proxy reset, or wrapper-not a product.
- Generic HTTP server headers often identify the edge only.
- SSH protocol/software strings may be vendor-masked or patched.
- Database wire compatibility does not prove the upstream engine.
- RDP, SMB, LDAP, and Kerberos capabilities reveal security posture more reliably than open ports alone.
- A service on a surprising port should be probed by protocol, not relabeled from the port number.

## Scan loss and distortion

Look for:

- source port filtering;
- SYN cookies/proxies;
- load balancer member drift;
- anycast path changes;
- port knocking or first-packet state;
- per-source connection quotas;
- IDS-induced resets;
- asymmetric routing;
- VPN MTU/fragmentation;
- container/NAT publication that differs by interface;
- short-lived serverless/ephemeral listeners.

Keep a periodic canary probe to a known-open service. If canary behavior changes, segment conclusions by time window.

## Evidence confidence

- **Confirmed service:** native protocol exchange or authenticated capability proves identity.
- **Probable service:** version detection plus consistent protocol-specific behavior.
- **Candidate:** port/banner only.
- **Unknown:** filtered/ambiguous/transient.

Vulnerability matching begins only after identity and configuration confidence are sufficient for the candidate class.
