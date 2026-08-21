# Serverless Event Method

## Event contract

Record provider and trigger type, endpoint origin, source identity, signature version and covered bytes, event identifier, tenant source, schema version, timestamp window, retry metadata, idempotency key, expected effect, and cleanup owner.

## Matched cases

- Change one canonicalization input without changing the intended event.
- Replay the same tester-owned event inside and outside the accepted window.
- Vary source and tenant metadata independently of body claims.
- Compare first delivery, provider retry, duplicate delivery, dead-letter redrive, and partial downstream failure.
- Confirm whether validation occurs before any state mutation or fan-out.

Preserve raw redacted transport evidence and durable state evidence. Stop on unexpected cost, fan-out, irreversible mutation, or delivery beyond the authorized fixture.
