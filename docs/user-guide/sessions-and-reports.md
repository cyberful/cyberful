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

Session metadata is stored in a global local SQLite database keyed by launch
directory. On Unix its database and sidecars use owner-only permissions. Resume
from the same directory with `cyberful run --continue` or select an id with
`cyberful run --session <id>`.

These files are local evidence, not telemetry. They may contain prompts, target
data, cookies, tool output, findings, and proof-of-concept material. Apply the
engagement retention policy and never attach them to a public issue without
sanitization.

Tool-decision results display both their stable reason code and human rationale.
The workarea's `raw/operations/tool-usage.csv` remains metadata-only and omits
rationale text and tool arguments. Phase transcripts are a separate evidence
record: they are enabled by default and can contain complete tool calls,
including rationale text. Set `CYBERFUL_SUBSYSTEM_TRANSCRIPT=0` only when the
engagement retention policy calls for disabling those raw transcripts.

## Reports

Report phases consume validated artifacts rather than unverified narrative.
PDFs include the executive summary, scope and limitations, reproducible
findings, evidence references, severity, and remediation guidance. Assessment
control mappings are compliance-readiness evidence, not certification or an
accredited attestation.

PDF generation is local and uses redistributed fonts; it makes no external
asset requests. Generated reports remain ignored by Git and should be shared
only through the engagement's approved delivery channel.
