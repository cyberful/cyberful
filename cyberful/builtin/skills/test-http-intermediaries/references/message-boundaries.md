# Message Boundaries and Normalization

## Boundary Differential Families

Review:

- conflicting or duplicated message-length indicators;
- transfer-coding token parsing, casing, whitespace, commas, and invalid values;
- bodyless-method and status assumptions;
- early responses and unread request bodies;
- HTTP/2 or HTTP/3 to HTTP/1 translation of length, authority, path, and pseudo-headers;
- header-name and value character acceptance;
- line endings, folding behavior, and forbidden hop-by-hop headers;
- upgrade, CONNECT-like, gRPC, and WebSocket translation paths.

For HTTP/2 and HTTP/3, reason from the translated downstream request rather than mechanically replaying HTTP/1 test cases.

## Target Normalization

Compare:

- percent-decoding order and double decoding;
- dot segments, duplicate slashes, backslashes, semicolons, and path parameters;
- Unicode normalization and invalid byte handling;
- encoded delimiters and question marks;
- absolute-form, authority-form, and origin-form targets;
- duplicate query parameters and mixed body/query sources;
- method override headers and framework routing fallbacks.

Security middleware and final routing must authorize the same canonical resource.

## Differential-Oriented Hints

- A front end may accept a body on a request the back end treats as bodyless, leaving bytes queued without classic length ambiguity.
- A back end that responds before consuming the request body can desynchronize a reusable upstream connection.
- Header removal at one hop can expose a duplicate retained by another.
- H2 pseudo-header validation can diverge from the generated H1 `Host` or request target.
- Response desynchronization can arise when an upstream client accepts a different response length than the component producing it.

Use a marker request owned by the tester and a fresh connection. Classify whether only a disagreement, tester-owned queue influence, or cross-request reach was observed.
