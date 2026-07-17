# WebSocket and Streaming Review

## Handshake

Review cookie or token authentication, Origin validation, subprotocol negotiation, proxy header trust, TLS termination, compression negotiation, query-string secrets, and whether normal HTTP middleware actually runs on upgrade.

Cross-site WebSocket hijacking requires a browser-initiated connection that carries ambient credentials and lacks an effective origin or request-bound defense. Prove what the resulting socket can read or do.

## Message Authorization

Treat message type, channel, object ID, tenant, actor, and fields as untrusted. Authorize every operation at the server. Validate schema before dispatch and reject unknown types or fields.

Test:

- publish versus subscribe permissions;
- private, group, presence, and administrative channels;
- history and backlog access;
- wildcard, pattern, and batch subscriptions;
- role or ownership changes on a live connection;
- resume tokens and cursor manipulation;
- namespace ambiguity and case normalization.

## Streaming-Specific Hints

- SSE endpoints can leak data through redirects, shared caches, permissive CORS, or missing per-event authorization.
- A gateway may authorize the upgrade path but pass a different normalized path or tenant to the socket service.
- Socket servers often trust user IDs embedded in client messages because the handshake already authenticated someone.
- Backpressure failures can exhaust memory when clients read slowly; per-connection message limits do not bound queued outbound bytes.
- Compression context reuse can create side channels when secrets and reflected input share a compressed stream.
- Reconnect may restore subscriptions from stale server state after revocation.

## Evidence

Record handshake request, negotiated protocol, connection identity, exact message sequence, outbound events, durable state, and whether a clean second principal receives or influences data.
