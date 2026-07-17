---
name: test-realtime-integrations
description: Assess WebSocket, Server-Sent Events, webhook, event-stream, callback, and asynchronous integration security during authorized penetration tests or code audits. Use for handshake and message authorization, cross-site WebSocket hijacking, channel isolation, replay, ordering, signature verification, canonicalization, event forgery, subscription leaks, retry behavior, and integration confused deputies.
---

# Test Realtime and Event Integrations

## Model Connection, Channel, and Event Authority

Separate authentication and authorization at:

- transport handshake;
- connection establishment;
- subscription or channel join;
- each inbound command;
- each outbound event;
- reconnect and resume;
- asynchronous delivery and replay.

Record principal, tenant, origin, token source, channel key, object relationship, message type, sequence, and state. A connection authenticated once can still cross authorization boundaries as roles, tenants, or object ownership change.

Read [websocket-sse.md](references/websocket-sse.md) for bidirectional and streaming channels. Read [webhook-events.md](references/webhook-events.md) for signed callbacks, ordering, and retries.

## Build a Protocol State Matrix

Capture the normal sequence and then vary one dimension: send before subscribe, subscribe before authentication, change tenant mid-connection, reuse a resume token, reorder frames, duplicate events, omit fields, add unknown fields, and reconnect after revocation.

Compare UI-generated traffic with direct protocol messages. Client code frequently hides message types, sequence fields, channel selectors, and administrative actions.

## Prove Isolation

Use two controlled principals and at least two tenants or resource owners. Test predictable and observed channel identifiers, wildcard subscriptions, filter changes, batch subscriptions, history endpoints, presence lists, typing indicators, error messages, and compressed frames.

For server push, verify that each publication is authorized against current state or a correctly invalidated authorization snapshot.

## Test Integrity and Freshness

For webhooks and callbacks, verify signature construction, canonical bytes, algorithm and key selection, timestamp window, nonce or event ID, replay storage, secret rotation, destination binding, and verification before parsing or side effects.

For queues and event streams, test duplicate delivery, out-of-order delivery, poison messages, partial failure, redrive, schema evolution, and event provenance.

## Report the Failing Boundary

Document transport state, message or event, principal and channel mapping, ordering prerequisites, current versus stale authorization, and durable effect. Recommend message-level authorization, explicit schema, replay controls, transactional consumption, and bounded connection resources.
