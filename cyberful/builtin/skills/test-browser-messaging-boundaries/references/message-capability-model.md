# Browser Message Capability Model

## Sender proof

Validate exact serialized origin and the expected sender object where the API exposes one. Re-check authority for the requested operation; possession of a window, port, worker, or channel reference is not blanket authorization.

## Receiver and lifecycle

Bind handlers to a closed message schema and reject unknown types and fields. Consider navigation, opener replacement, frame reuse, worker restart, service-worker scope changes, extension update, port transfer, and listener lifetime.

## High-value capabilities

Prioritize credential or token release, navigation, DOM mutation, storage reads, network requests, account actions, extension APIs, native messaging, clipboard, downloads, signing, and cross-tenant data. Record the concrete effect rather than equating message receipt with compromise.

