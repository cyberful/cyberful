# How Cyberful is put together

Cyberful is the coordinator. It keeps the scope, session, evidence, tools, and
report under control while Codex works on one phase at a time. Cyberful does not
ship its own AI model.

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
        │                         ├── headless OWASP ZAP
        │                         └── persistent headless Ghidra
        └── validated handoff ── next fresh process
```

Every sequential phase gets a new Codex process and private gateway. Advancement
requires a validated handoff and required artifact; the current process and
gateway exit before the successor starts. Durable state lives in the workarea,
session journal, local Code Graph, host source store, and host Ghidra project
store rather than hidden model context. Both stores are outside the
model-writable workarea. The source store exposes authoritative imports and
snapshots only through bounded read-only operations; the Ghidra store exposes
its project through the authenticated headless MCP and retains annotations
between runtime instances.

Codex is the current app-server implementation behind the `Subsystem`
boundary. That boundary owns runtime identity, lifecycle, usage, failure, and
completion contracts without making session or gateway code Codex-specific.
Adding another app-server therefore requires a new subsystem implementation,
not a parallel execution path.

Runtime notifications have one `Event` definition and publication surface.
Versioned aggregate events enter transactional projection once and reach live
subscribers only after commit; transient events go directly to the instance
bus. The public event catalog, persistence schema, and SSE schema all derive
from those same definitions.

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

The terminal's home footer, notifications, keyboard guide, and diff viewer are
host-owned capabilities wired directly into the TUI. Their commands, listeners,
routes, and visual slots have explicit teardown; there is no runtime-loaded TUI
plugin layer.
