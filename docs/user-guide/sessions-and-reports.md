# Sessions, configuration, and reports

Agent routing has one strict source: `settings.yaml` in the launch directory.
It selects the Pi main and optional fallback providers, models, delegation
limits, fallback policy, and explicitly trusted persona or skill roots. It
never contains credentials. See
[Agent providers and fallback](settings.md).

Operational environment configuration uses descending precedence:

1. the real process environment;
2. `.env` in the directory where Cyberful is launched;
3. defaults embedded in the release binary.

Use
[`.env-example`](https://github.com/cyberful/cyberful/blob/main/.env-example)
as the portable template. Do not commit credentials, tokens, personal
browser-profile paths, or engagement endpoints.

## Local data

Runtime artifacts are rooted in the launch directory:

```text
work/<slug>/            phase artifacts and evidence
logs/session-logs/      session journals and phase transcripts
reports/<timestamp>/    generated report output
```

Authoritative public-source imports and immutable source snapshots are the
exception: Cyberful keeps them below the platform application-data directory in
an owner-only `cyberful/source-store/<workarea-hash>/` tree, outside the
model-writable workarea. The store is durable for resume and should follow the
same engagement retention policy as the corresponding workarea. Its import key
is host-only and independent from session variables and the Code Graph ledger.

Session metadata is stored in a global local SQLite database keyed by launch
directory. On Unix its database and sidecars use owner-only permissions. Resume
from the same directory with `cyberful run --continue` or select an id with
`cyberful run --session <id>`.

## Steer an active session from another terminal

Use `session steer` to add short, routine guidance to an AgentRun that is
already running. The ordinary TUI uses an internal transport, so expose its
loopback control plane when starting it.

Terminal 1:

```sh
cyberful --port 4096
```

Terminal 2:

```sh
cyberful session steer ses_... \
  --attach http://localhost:4096 \
  --message "No CAPTCHA is visible. Recheck the active page and continue without treating SDK traffic as a challenge."
```

Use the session ID shown by the TUI, or run `cyberful session list` from the
same launch directory.

`--attach` is required and must match the port chosen when the TUI started. A
TUI that was started without an explicit `--port` is intentionally not
reachable from another process; start future runs with a port when command
steering will be needed. Add `--dir /remote/launch/directory` when that server
hosts more than one launch directory. Basic Auth uses `-u`/`-p`, or
`CYBERFUL_SERVER_USERNAME`/`CYBERFUL_SERVER_PASSWORD`.

The command prints `Steering accepted` only after the active root AgentRun
acknowledges the text. It exits with an error if the session is idle, finished,
a child session, missing, or no longer able to accept steering. It never starts
a new turn.

Steering is context, not authorization. It cannot answer a pending question,
approve an action, or resolve a CAPTCHA handoff. For a pending CAPTCHA question,
inspect its immutable choices and answer the exact request instead:

```sh
cyberful approval list --session ses_...
cyberful approval reply que_... --select "No challenge visible"
```

Choose `No challenge visible` only after a human checks the browser Cyberful
foregrounded. `Resolved` means the human actually completed the visible
challenge; `Cannot resolve` keeps the affected browser profile and origin
paused.

An active turn created by the removed Codex runtime cannot be resumed through
Pi: Cyberful rejects both additional prompts and execution for that turn before
contacting a provider. Its completed reports, transcripts, artifacts, and
history remain readable. Once the legacy workflow is complete, a new Ask turn
may be started normally and is recorded as a Pi run.

These files are local evidence, not telemetry. They may contain prompts, target
data, cookies, tool output, findings, and proof-of-concept material. Apply the
engagement retention policy and never attach them to a public issue without
sanitization.

Actual gateway tool calls are summarized in the workarea's metadata-only
`raw/operations/tool-usage.csv`, which omits tool arguments and response
content. Every error row has a controlled `error_class`: `timeout`,
`nonzero_exit`, `tool_reported_error`, `invalid_arguments`, or `transport`.
Separate metadata columns retain a bounded error code, tool exit code, and the
resolved browser profile—including default profile `1`—without storing the
payload.

Phase transcripts are created owner-only at phase start and grow
incrementally. They contain complete redacted tool events followed by a
host-owned terminal status, so an interruption preserves the partial record
already written. Provider credentials, private gateway environment, and the
complete compiled system message are excluded. Provider failures retain their
normalized kind, status and code when available, plus a bounded,
credential-redacted operator diagnostic; raw provider diagnostics are not
persisted.

Provider usage is append-only at `raw/operations/provider-usage.jsonl`, one
entry per provider call with run ancestry and disjoint token fields. Sanitized
gateway, MCP, ZAP, and browser lifecycle failures are separately retained at
`raw/operations/runtime-diagnostics.jsonl`; neither artifact is inserted into
model context automatically.

Large results sent to the terminal are a display concern only. Cyberful keeps
the model and transcript result unchanged, stores one redacted copy under
`raw/tool-results/` with its byte size and SHA-256, and sends at most 12 KiB to
the collapsed TUI card. Expanding the card reads at most 64 KiB through a
session-scoped, symlink-safe endpoint; **load more** advances through the
artifact without loading a multi-megabyte result at once.

## Session variables

Agents save reusable values in the session store and reference them in later
tool arguments as `{{var:name}}`. The gateway expands these references only for
the destination tool and redacts matching values before tool output returns to
the model.

A value containing `[redacted:variable:...]` is already a display-safe
substitute rather than the original data. Cyberful refuses to save or resolve
such a value, preventing a partially redacted URL, command, or token from being
reused as actionable input. This guard adds no variable type or configuration;
ordinary JSON values and the `{{var:name}}` syntax are unchanged.

## Reports

Report phases consume validated artifacts rather than unverified narrative.
PDFs include the executive summary, scope and limitations, reproducible
findings, evidence references, severity, and remediation guidance. Code Audit
control mappings are evidence about the examined implementation, not
certification or an accredited attestation.

Bug Bounty Program produces Markdown instead of a consolidated PDF. Its
`BUG_BOUNTY_REPORT.md` index links one portable report per submission-ready
finding under `reports/bug-bounty/`. Held and non-reportable candidates remain
visible in the index without becoming submission files. Duplicate lookup,
platform acceptance, reward estimation, and automatic submission are outside
the workflow.

PDF generation is local and uses redistributed fonts; it makes no external
asset requests. Generated reports remain ignored by Git and should be shared
only through the engagement's approved delivery channel.
