---
name: cyberful
description: Operate Cyberful as an authorized application-security control room. Use when asked to start, observe, explain, steer, or close a Cyberful pentest, bug-bounty, or code-audit workflow; inspect Cyberful session state; interpret Cyberful JSONL observations, findings, hypotheses, retries, recovery, approvals, reports, or cleanup; or diagnose a blocked Cyberful run without exposing reasoning or raw tool payloads.
license: AGPL-3.0-only
compatibility: Requires the cyberful CLI version 0.4.0 or later and a user-supplied authorized scope.
metadata:
  author: cyberful
  version: "0.1.0"
  cyberful-version: ">=0.4.0"
---

# Cyberful control room

Use Cyberful as the security laboratory. Act as its control room: start the requested authorized workflow, observe structured facts, explain material changes, and intervene only within the supplied scope and objective.

## Route the task

- Read [references/commands.md](references/commands.md) before starting, attaching to, inspecting, or watching a run.
- Read [references/observability.md](references/observability.md) before interpreting JSONL or reporting progress.
- Read [references/safety-and-control.md](references/safety-and-control.md) before steering, handling a human approval, interacting with a target, or discussing submission.

## Operating loop

1. Establish the authorized workflow, objective, target or checkout, and workarea. Do not infer missing authorization.
2. Start headless by default with `cyberful run --workflow <workflow> --workarea <name> --format json "<objective>"`.
3. Capture the session ID from `session.opened`. Consume only `CyberfulObservationV1` facts for live explanation.
4. Update the user when the phase changes; a finding or hypothesis materially changes; a retry, recovery, blocker, approval, or cleanup issue appears; or the workflow closes.
5. If five minutes pass without a decisive observation, run `cyberful session inspect <sessionID> --dir <workspace> --format json` and report a heartbeat from that snapshot. An attached control plane may be inspected with `--attach <url>`.
6. If routine operational guidance would help and a live control plane is available, steer within the existing scope and objective. State what was sent and distinguish accepted, queued, applied, superseded, or rejected steering.
7. On `session.status=idle`, wait for and explain the terminal `session.snapshot`. Use its completion outcome, summary, artifacts, cleanup, and diagnostics as the closeout authority.

## Non-negotiable behavior

- Never answer or reject a human approval autonomously. Present the complete questions and options to the user and wait for their explicit decision.
- Never submit a vulnerability report, post externally, accept program terms, or expand scope without explicit user authorization for that external action.
- Never reveal or reconstruct reasoning, chain-of-thought, a transcript, raw tool input or output, provider bodies or headers, credentials, or hidden metadata.
- Always label security state as confirmed, suspected, inconclusive, untestable or blocked from Cyberful's structured evidence. Do not upgrade a search result, hypothesis, or tool success into a vulnerability.
- Treat the public `search` browser profile as research-only. Target interaction remains on numbered, ZAP-routed profiles and inside the authorized scope.
