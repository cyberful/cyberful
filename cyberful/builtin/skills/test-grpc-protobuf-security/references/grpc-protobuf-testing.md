# gRPC and Protobuf Testing

Use this reference after service and method scope is explicit. Begin with one unary control and preserve the exact descriptor set or reflection response used.

## Method and metadata boundaries

- Inventory package, service, method, request/response type, unary or streaming shape, reflection exposure, health endpoints, and transcoding aliases.
- Trace identity from transport credentials and metadata into interceptors and handlers. Test duplicate, mixed-case, binary, forwarded, and deadline metadata without smuggling secrets into the payload artifact.
- Compare direct backend and gateway behavior only when both origins are independently authorized.

## Protobuf semantics

- Distinguish absent from default for optional and wrapper fields.
- Exercise unknown fields, duplicate encodings, enum unknowns, packed/unpacked repeated fields, oneof replacement, maps, `Any`, recursive messages, field masks, and numeric boundaries with tiny payloads.
- Confirm that JSON transcoding preserves the same presence, casing, number, bytes, enum, and unknown-field decisions.

## Streams and resources

- Bound message count, size, concurrency, and duration before testing client, server, or bidirectional streams.
- Test authorization over stream lifetime, cancellation, reconnect, half-close, backpressure, compression, and per-message tenant context.
- A timeout or resource error is not a denial-of-service finding without a reproducible bounded cost differential and a defensible availability impact.

## Evidence

Record full method, origin, descriptor digest, transport mode, actor, tenant, metadata names, request digest, gRPC status, trailers, response digest, timing, and observed side effect. Redact credentials and retain only their environment name and digest.
