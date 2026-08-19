# Automation Abuse Testing

## Identity and communication boundaries

Use accounts, email addresses, phone numbers, devices, sessions, and API clients owned by the engagement. Route email or SMS only to approved test sinks. Record which identity attributes may be reused and which third-party systems must not receive traffic.

## Rate design

Define total requests, accounts, messages, concurrency, and duration before testing. Start with a normal control and the smallest automation contrast. Threshold discovery by unbounded ramping is not a valid objective.

## Distinguish controls

Separate network rate limiting, account velocity, device reputation, behavioral detection, proof-of-work or challenge, credential defense, verification issuance, account activation, and downstream resource allocation. A challenge response does not prove that account or resource creation was prevented.

## Evidence

Capture control decisions and reasons, request counts, account or authentication state, verification issuance and consumption, resource allocation, lockout or recovery state, downstream effects, and cleanup. Correlate only pseudonymous controlled identities.

## Stopping conditions

Stop on any non-test recipient, unexpected lockout outside the identity pool, shared inventory or capacity impact, operational request to stop, third-party anti-abuse escalation, or loss of authoritative evidence.
