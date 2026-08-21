# Recovery assurance method

Use this method for a tester-controlled identity with an explicit restoration path and a bounded set of ceremonies.

## Precondition record

Capture account identifier, tenant, enrolled authenticators, verified channels, active sessions, API credentials, trusted devices, federation links, recovery artifacts, assurance level, and notification destinations. Do not retain secret values in the ledger.

## Ceremony dimensions

- Initiation: authenticated, unauthenticated, support-assisted, administrator-assisted, or federated fallback.
- Evidence: knowledge, possession, inherence, recovery code, device state, prior session, organizational approval, or manual proofing.
- Freshness: issuance time, attempt ceiling, resend behavior, parallel challenge behavior, and invalidation event.
- Binding: intended account, tenant, channel, browser or device, initiating session, action, and final authenticator.
- Result: password, factor, channel, session, device trust, federation link, API credential, and owner notification state.

## Controlled comparisons

Begin with one documented success and one expected denial. Then test replay after success, parallel challenges, resend invalidation, initiation before an identifier change, completion after a change, old-session survival, channel reassignment, and support override. Avoid guessing or high-rate attempts; recovery throttling is a separate availability and abuse-control question.

## Confirmation record

Record the minimum missing evidence, server-side acceptance, resulting authority, persistence, invalidation behavior, notification, audit trail, and restoration result. A user enumeration difference or delivered message alone is not account takeover; state the concrete authority obtained or retained.
