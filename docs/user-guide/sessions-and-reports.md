# Sessions, configuration, and reports

Cyberful layers configuration in descending precedence:

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
an owner-only `cyberful/source-store/<workarea-hash>/` tree, outside the Codex
writable root. The store is durable for resume and should follow the same
engagement retention policy as the corresponding workarea. Its import key is
host-only and independent from session variables and the Code Graph ledger.

Session metadata is stored in a global local SQLite database keyed by launch
directory. On Unix its database and sidecars use owner-only permissions. Resume
from the same directory with `cyberful run --continue` or select an id with
`cyberful run --session <id>`.

These files are local evidence, not telemetry. They may contain prompts, target
data, cookies, tool output, findings, and proof-of-concept material. Apply the
engagement retention policy and never attach them to a public issue without
sanitization.

Actual gateway tool calls are summarized in the workarea's metadata-only
`raw/operations/tool-usage.csv`, which omits tool arguments and response
content. Phase transcripts are a separate evidence record: they are enabled by
default and can contain complete tool calls. Set
`CYBERFUL_SUBSYSTEM_TRANSCRIPT=0` only when the engagement retention policy
calls for disabling those raw transcripts.

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
findings, evidence references, severity, and remediation guidance. Assessment
control mappings are compliance-readiness evidence, not certification or an
accredited attestation.

PDF generation is local and uses redistributed fonts; it makes no external
asset requests. Generated reports remain ignored by Git and should be shared
only through the engagement's approved delivery channel.
