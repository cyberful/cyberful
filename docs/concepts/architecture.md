# How Cyberful is put together

Cyberful is the coordinator. It keeps the scope, session, evidence, tools, and
report under control while Pi Agent works on one phase at a time. Cyberful does not
ship its own AI model.

```text
TUI and session journal
        │
workflow and phase controller
        │
in-process Pi phase owner ─── private phase gateway
        │                         ├── read-only host source store
        │                         ├── Code Graph
        │                         ├── unified engagement container
        │                         │     ├── cyberful-os tools
        │                         │     ├── headless OWASP ZAP
        │                         │     └── persistent headless Ghidra
        │                         ├── isolated browser
        │                         └── optional EVM runtime
        ├── root AgentRun
        ├── delegated AgentRun tree
        ├── fallback AgentRun tree
        └── root-only handoff ── next fresh owner
```

Every sequential phase gets a new in-process Pi worker owner and private
gateway. Advancement
requires a validated handoff from the original root and a required artifact;
the owner shuts down and the gateway exits before the successor starts. Durable
state lives in the workarea, session journal, local Code Graph, host source
store, and host Ghidra project store rather than hidden model context. Both
stores are outside the model-writable workarea. The source store exposes
authoritative imports and snapshots only through bounded read-only operations;
the Ghidra store exposes its project through the authenticated headless MCP and
retains annotations between phase owners.

`PiAgentSubsystem` is the only production implementation of the
`AgentSubsystem` lifecycle boundary. It starts complete `AgentRun` instances
for roots, subagents, and fallback tasks and publishes a common stream of
events, result, usage, and normalized failure data. OpenAI Codex, Z.AI Coding
Plan, Kimi For Coding, and reviewed OpenAI-compatible adapters are inference
providers inside Pi; they are not parallel runtimes.

The host resolves provider and model before starting a run. The original phase
root uses the main route. Main-route children normally retain that route.
Fallback roots use the configured fallback route and their entire descendant
tree retains fallback affinity. Only the original root receives the `handoff`
capability, while every allowed child can still use phase tools, skills, write
artifacts, and create bounded descendants.

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
Likewise, Pi does not discover configuration from `~/.pi`, `.codex`, `.agents`,
`.claude`, or the target repository. Operator extensions are available only
from trusted roots explicitly listed in `settings.yaml`.

The terminal's home footer, notifications, keyboard guide, and diff viewer are
host-owned capabilities wired directly into the TUI. Their commands, listeners,
routes, and visual slots have explicit teardown; there is no runtime-loaded TUI
plugin layer.
