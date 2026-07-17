# How Cyberful is put together

Cyberful is the coordinator. It keeps the scope, session, evidence, tools, and
report under control while the subsystem (codex) works on one phase at a time.
Cyberful does not ship its own AI model.

```text
TUI and session journal
        │
workflow and phase controller
        │
fresh Codex app-server ── private phase gateway
        │                         ├── Code Graph
        │                         ├── cyberful-os
        │                         ├── isolated browser
        │                         └── headless OWASP ZAP
        └── validated handoff ── next fresh process
```

Every sequential phase gets a new Codex process and private gateway. Advancement
requires a validated handoff and required artifact; the current process and
gateway exit before the successor starts. Durable state lives in the workarea,
session journal, and local Code Graph rather than hidden model context.

First-party personas, skills, budgets, instructions, and MCP policy live under
`cyberful/builtin/` and are embedded in release binaries. The complete component
and trust-boundary reference is in the repository's
[`ARCHITECTURE.md`](https://github.com/cyberful/cyberful/blob/main/ARCHITECTURE.md).
