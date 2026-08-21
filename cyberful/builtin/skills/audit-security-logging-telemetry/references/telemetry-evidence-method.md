# Telemetry evidence method

## Start from decisions

Choose a protected effect or abuse hypothesis before choosing a log source. State the reconstruction question, the actor and object identifiers needed to answer it, the maximum acceptable delay, and the retention horizon. Inventorying every emitted field without this question creates volume rather than evidence.

## Trace semantic custody

For each event, preserve where each field originates, which component can modify it, and whether correlation survives queues, retries, fan-out, batching, sampling, and schema migration. Distinguish application assertions from gateway observations and infrastructure metadata. Record which clock generated each timestamp and how skew is bounded.

## Challenge failure modes

Test denied operations, partial commits, retries, duplicate messages, buffer saturation, collector loss, destination unavailability, tenant boundaries, privileged configuration changes, retention expiry, and deletion. Verify alert consumers against the stored representation rather than an idealized producer event.

## Bound conclusions

An emitted event is not proof it arrived; an indexed event is not proof an alert consumed it; an alert definition is not proof it fired. Preserve the event identifier, query, time range, pipeline stage, and negative-control result for each conclusion.
