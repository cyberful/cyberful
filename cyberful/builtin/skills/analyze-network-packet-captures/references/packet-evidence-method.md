# Packet evidence method

## Confirm provenance

Record capture interface, vantage point, filter, snap length, clock source, start and stop conditions, and whether offload, encapsulation, packet loss, or redaction changed the evidence. Hash the source before interpretation.

## Validate structure first

Check file format, byte order, timestamp precision, record boundaries, included versus original lengths, monotonicity, link type, and cumulative limits. A truncated or malformed capture may still answer a narrow question, but its limitations must travel with every conclusion.

## Correlate at the right layer

Packet presence shows observation at one vantage point, not application acceptance or durable effect. Reconcile endpoints, direction, protocol state, retransmission, intermediary behavior, application identifiers, and server telemetry. Avoid identifying payload semantics from ports alone.
