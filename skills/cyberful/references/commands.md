# Commands

## Preconditions

Run `cyberful --version` and require Cyberful 0.4.0 or later. Work from the authorized project directory. Choose one workflow:

- `pentest` for an authorized external or internal application assessment.
- `bug-bounty` for a program whose policy and scope the user supplied or approved.
- `code-audit` for a read-only audit of the local checkout; its disposable execution lab is isolated and destroyed at closeout.

Use a stable workarea name because durable lifecycle, evidence, findings, usage, reports, and cleanup live below it.

Inspection is the default control-room action. Starting a new run performs authorized security work and requires the user's explicit request in the current task. Do not infer permission to start from an available target, program page, earlier run, or installed Cyberful CLI.

## Headless run

When the user explicitly requests a new run, start this way unless they specifically want the TUI:

```sh
cyberful run --workflow <pentest|bug-bounty|code-audit> --workarea <name> --format json "<authorized objective>"
```

The first observation is `session.opened`. Use its `sessionID` only as an opaque local selector for that run. It is intentionally present in the public observation envelope and is not a bearer token, credential, or proof of authorization. JSON output is `CyberfulObservationV1` JSONL; do not parse it as the pre-0.4.0 event shape.

Never ask the user for a password, API key, token, cookie, provider header, or other secret, and never place one in conversation or model-visible command text. When a control plane requires authentication, the user must configure it in their own environment outside the agent's context.

The run exits 0 for `success` or `warning`, and 1 for `blocked` or `failed`. Use the terminal snapshot rather than the shell code alone to explain the outcome.

## TUI with a live control plane

Start the TUI with a loopback control plane when another process must supervise it:

```sh
cyberful --port 4096
```

Use the URL shown by Cyberful. The human operator configures control-plane authentication through the CLI's supported options or environment-backed server credentials without disclosing the values to the agent.

## Inspect

Read the latest durable snapshot without an attached TUI:

```sh
cyberful session inspect <sessionID> --dir <workspace> --format json
```

Read live connection state plus durable facts through a control plane:

```sh
cyberful session inspect <sessionID> --attach http://localhost:4096 --dir <workspace> --format json
```

Use `--format table` for a concise human view. A durable inspection deliberately reports `source.connection=not-attached`; do not describe that as live.

## Watch

`watch` requires an attached control plane:

```sh
cyberful session watch <sessionID> --attach http://localhost:4096 --dir <workspace> --format json
```

Use `--format text` for a human-readable stream. Watch emits an initial snapshot, session-scoped events, resnapshots after reconnection, and a terminal snapshot after the final Report frames before it exits on `idle`.

## Steering

Send only routine operational guidance within the current authorization and objective:

```sh
cyberful session steer <sessionID> --attach http://localhost:4096 --message "<guidance>"
```

Use `--focus` only when the user wants queued guidance superseded and delegated work cancelled before applying the new direction. Report the returned receipt and do not claim steering was applied when it is only accepted or queued.

## Human approvals

The coding agent presents approvals but never resolves them. A human can inspect the mailbox with:

```sh
cyberful approval list --session <sessionID> --format json
```

After an explicit user decision, tell the user the exact `cyberful approval reply` or `cyberful approval reject` command they can run. Do not run it on their behalf as part of this skill.
