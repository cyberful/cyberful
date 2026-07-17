# Webhook and Event Security

## Signature Verification

Verify signatures over exact raw bytes before lossy parsing. Bind version, algorithm, key ID, destination or tenant, timestamp, and event identity. Use constant-time comparison and constrain accepted algorithms and keys.

Check ambiguity from JSON reserialization, duplicate keys, whitespace, Unicode, number representation, header duplication, content encoding, chunking, and proxy body transformations.

## Replay and Ordering

Define freshness using a signed timestamp plus durable event ID. Store replay state for the full redelivery window and bind it to provider and destination. Do not assume events arrive once or in order.

Test:

- same event and signature replayed;
- same event ID with altered body;
- older valid event after a newer state;
- concurrent duplicates;
- retry after a timeout where the first attempt committed;
- redrive from dead-letter storage;
- secret rotation overlap.

## Destination and Confused Deputies

Review who can register or change callback URLs, which network the sender can reach, whether credentials or tenant context attach to delivery, and whether validation follows redirects. A webhook configuration feature can combine SSRF, secret disclosure, and cross-tenant event delivery.

## Consumer Semantics

Trace verification, parsing, deduplication, authorization, state transition, side effect, acknowledgement, and retry. The acknowledgement must reflect durable processing semantics; returning success before commit can drop events, while returning failure after commit can duplicate them.

## Advanced Hints

- Providers may sign the compressed body while middleware verifies decompressed bytes, or the reverse.
- Multiple signature headers during rotation can trigger first-versus-last parser disagreement.
- Test and live environments may share callback secrets or event IDs.
- Event type is often trusted to select a deserializer or privileged handler.
- An event may be authentic but not authorized for the local tenant, object, or current lifecycle state.
- Webhook preview, resend, and troubleshooting tools often use broader network and credential access than normal delivery.
