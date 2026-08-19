# HTTP evidence method

## Preserve capture context

Record who captured the traffic, browser or client state, proxy path, account and tenant role, target origin, time range, and mutations applied. A HAR is a client-visible representation and may omit HTTP/2 or HTTP/3 framing, proxy transformations, bodies, trailers, and connection reuse.

## Compare controlled variants

Hold all but one dimension stable when comparing transactions: identity, tenant, method, path, parameter, content type, cache state, or intermediary. Treat redirects and retries as separate causal hops. Use source digest and entry index to return to raw evidence whenever a structural difference matters.

## Bound inference

Header presence does not prove the server consumed it; a cookie does not prove a session was accepted; a status code does not prove durable effect. Corroborate with response content, server-side state, telemetry, or a controlled reproduction before reporting a vulnerability.
