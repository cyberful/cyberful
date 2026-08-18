# TLS Fieldbook

## High-signal discrepancies

- A certificate succeeds in browsers but fails in OpenSSL: test alternate-chain delivery, AIA fetching, trust-store differences, and missing intermediates.
- TLS 1.0 appears only on one IP: suspect an unrotated edge pool, health endpoint, or direct origin.
- HTTP/2 and HTTP/1.1 return different certificates or controls: the ALPN routes may terminate in different stacks.
- A listener asks for a client certificate only after a specific SNI: reproduce with that exact name; IP scans understate mTLS.
- Resumed sessions retain authorization or identity state across configuration changes: test ticket lifetime, key sharing, and tenant/hostname boundaries.
- OCSP stapling varies by edge: distinguish transient responder failure from a systematic no-staple policy.

## Rare but valuable probes

- Compare SNI omitted, empty, valid, sibling, wildcard-adjacent, trailing-dot, IDNA, and case variants.
- Compare TLS 1.2 session IDs, TLS 1.2 tickets, and TLS 1.3 PSKs separately.
- Test whether 0-RTT reaches a state-changing application path; negotiation support alone is not impact.
- Inspect certificate EKU, path-length, name constraints, critical extensions, signature algorithm at every chain link, and leaf/public-key reuse.
- Test client-auth behavior with no certificate, unrelated CA, expired certificate, valid certificate with wrong EKU, and a valid identity lacking application authorization.
- For STARTTLS, test pre-upgrade command injection, capability stripping, mandatory-upgrade policy, and state reset after negotiation.

## Scanner disagreement protocol

1. Pin hostname and resolved IP.
2. Capture the offered ClientHello properties if available.
3. Reproduce one claimed protocol/cipher with a direct client.
4. Repeat from the same and a second vantage.
5. Identify whether failure is network, handshake, trust, application, or tool parsing.
6. Report the negotiated artifact, not a scanner label.

## False-negative traps

CDN sampling, IPv6 neglect, non-HTTP TLS, UDP/QUIC omission, private CA trust, mTLS gates, SNI routing, rate controls, connection reuse, session resumption, and edge/origin separation.
