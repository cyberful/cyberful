# How Cyberful is put together

Cyberful is the coordinator. It keeps the scope, session, evidence, tools, and
report under control while the primary subsystem (Codex) works on one phase at
a time. Cyberful does not ship its own AI model. An operator can optionally
attach a pre-started local Responses server for bounded assistance and recovery.

```text
TUI and session journal
        │
workflow and phase controller
        │
fresh Codex app-server ── private phase gateway
        │                         ├── read-only host source store
        │                         ├── Code Graph
        │                         ├── cyberful-os
        │                         ├── isolated browser
        │                         └── headless OWASP ZAP
        └── validated handoff ── next fresh process

recoverable primary or output-contract failure
        └── reap and collect primary ── one local recovery ── validate the same phase handoff
```

Every sequential phase gets a new Codex process and private gateway. Advancement
requires a validated handoff and required artifact; the current process and
gateway exit before the successor starts. Durable state lives in the workarea,
session journal, local Code Graph, and host source store rather than hidden
model context. The store is outside the model-writable workarea and contains
authoritative imports, snapshots, and a durable per-workarea import key. It is
published only through bounded read-only gateway operations.

The optional fallback is loaded once from `fallback-server.yaml` in the launch
directory and enabled only after a loopback preflight. It is not another normal
workflow route: the primary may make serialized autonomous delegations without
a numeric cap while budget remains, and the host may start one recovery after a
recoverable primary execution fails or leaves its output contract incomplete.
Both inherit phase scope, workarea, active budget, approval decisions, gateway
controls, rate limits, and circuit breakers; neither may recurse. Details are in
[Local fallback inference](../runtimes/fallback-inference.md).

The workarea remains model-writable evidence space, but ownership is narrow:
post-run Markdown normalization receives only the current phase's required
deliverable. Code Audit advancement from Index to Trace additionally requires
a host-verified source preflight plus a matching signed graph-snapshot and
coverage record after the gateway has exited.

First-party personas, skills, budgets, instructions, and MCP policy live under
`cyberful/builtin/` and are embedded in release binaries. The complete component
and trust-boundary reference is in the repository's
[`ARCHITECTURE.md`](https://github.com/cyberful/cyberful/blob/main/ARCHITECTURE.md).

Repository files that resemble those first-party controls—including
`AGENTS.md`, skills, and prompts—are target-controlled evidence. They are not
loaded as operational policy and cannot override the embedded instruction set.
