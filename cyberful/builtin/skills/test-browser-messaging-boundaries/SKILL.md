---
name: test-browser-messaging-boundaries
description: Test browser capability transfer across postMessage, opener, frame, portal, worker, service-worker, BroadcastChannel, MessagePort, and extension messaging boundaries. Use for origin-validation, source-binding, navigation-race, confused-deputy, channel-isolation, structured-clone, or privileged-message review.
metadata:
  domain: application-security
  subdomain: browser-messaging
  triggers:
    - postMessage security
    - cross frame messaging
    - opener trust boundary
    - worker message authorization
    - browser extension messaging
    - BroadcastChannel isolation
  tags:
    - browser
    - postMessage
    - iframe
    - worker
    - extension
    - origin-policy
  frameworks:
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test Browser Messaging Boundaries

Treat every message as a capability-bearing request. Validate sender origin, sender object, destination, message schema, freshness, and operation-level authority at the receiving boundary.

## Map channels and capabilities

Start from [assets/browser-message-matrix.example.json](assets/browser-message-matrix.example.json) and preserve [assets/browser-message-matrix.schema.json](assets/browser-message-matrix.schema.json). Include windows, frames, popups, portals, dedicated and shared workers, service workers, BroadcastChannel, MessagePort transfers, content scripts, extension pages, and native bridges.

Read [references/message-capability-model.md](references/message-capability-model.md) for sender and receiver invariants. Record navigation and lifecycle transitions because a previously trusted window reference can later host an untrusted origin.

## Test minimally

Use controlled origins and principals. Vary origin, `source`, channel, type, schema, target origin, ordering, replay, navigation timing, and transferred objects one dimension at a time. Observe the privileged operation or state transition, not just listener acceptance.

## Confirmation standard

Report sender and receiver contexts, exact message, validation order, transferred capability, navigation or lifecycle prerequisite, matched control, current authorization, security effect, and browser constraints. A wildcard target origin or missing check is a weakness until reachability and effect are proven.
