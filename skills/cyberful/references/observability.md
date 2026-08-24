# Observability

## Wire envelope

Cyberful 0.4.0 emits one compact JSON object per line:

```json
{"schemaVersion":1,"sequence":1,"timestamp":"2026-08-24T12:00:00.000Z","sessionID":"ses_...","type":"session.opened","data":{"workflow":"pentest"}}
```

Treat `schemaVersion`, `sequence`, `timestamp`, `sessionID`, `type`, and `data` as the public envelope. Sequence is monotonic within one CLI invocation, not a cross-process durable cursor.

## Observation types

- `session.opened`: the run has a session identity.
- `session.snapshot`: an initial, heartbeat, reconnected, or terminal `SessionInspectionV1` snapshot.
- `session.status`: live busy or idle state.
- `phase.activity`: a redacted phase/subsystem activity fact, optionally with actor, artifact, or usage metadata.
- `assistant.text`: completed assistant text intended for the user.
- `tool.finished`: tool name, call identity, status, safe title, and timing only. It never contains raw input, output, or error bodies.
- `findings.changed` and `hypotheses.changed`: registry revision hints. Inspect to obtain the current concise projection.
- `approval.requested` and `approval.resolved`: the human-decision lifecycle. Answer content is not streamed.
- `retry.updated`: attempt and safe retry classification without provider bodies, headers, or opaque metadata.
- `session.error`: a bounded public error projection.

Reasoning events, deltas, raw transcripts, shell contents, tool payloads, provider response bodies and headers, and unknown event types are not part of this wire.

## Snapshot authority

`SessionInspectionV1` combines independently sourced facts:

- `source` says whether live connection status is reliable or the snapshot is durable-only.
- `session` contains persisted session metadata.
- `lifecycle` contains workflow, phase, attempt, budget, freshness, retry/recovery, steering, and cleanup state when the durable run-state artifact is valid.
- `actors` contains counts and currently active redacted actors.
- `findings` and `hypotheses` contain concise current registry projections and revisions.
- `providerUsage` separates root and subagent totals.
- `approvals` contains complete pending questions and options without process-owner metadata.
- `completion` contains the final outcome, summary, artifacts, and structured failure when available.
- `diagnostics` names missing, invalid, or unavailable components. Omission plus a diagnostic is not an empty or negative security result.

## User updates

Report only decisive changes. A useful update says what phase Cyberful is in, what structured fact changed, how certain it is, and what happens next.

Use these exact evidence meanings:

- `CONFIRMED`: Cyberful has a reproduced, supported mechanism.
- `SUSPECTED`: positive evidence exists, but confirmation is incomplete.
- `INCONCLUSIVE`: available evidence does not discriminate the hypothesis.
- `UNTESTABLE`: a named blocker prevents the required test.
- `DISPROVED`: the tested claim did not survive the evidence oracle.
- Workflow `blocked`: completion could not proceed; state the structured blocker or diagnostic.

Do not use finding severity, a hypothesis state, tool success, or assistant prose as a substitute for the authoritative finding disposition and verification/submission decisions.

## Heartbeat and terminal ordering

After five minutes without a phase change, material registry revision, retry/recovery, approval, blocker, or completion, call `session inspect` and publish a short heartbeat. Include snapshot freshness and diagnostics.

When `session.status=idle` arrives, do not close from that event alone. `watch` and headless JSON output obtain the terminal snapshot after the final Report frames. Explain the completion summary, artifacts, cleanup verdict, and any missing component diagnostics, then use the completion outcome for the final status.
