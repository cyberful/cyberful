# Cyberful TUI Architecture

The terminal application is a local control plane around one model executor:
Codex. Session storage, orchestration, policy, MCP lifecycle, and reporting are
host responsibilities; model reasoning occurs in one ephemeral Codex process
per phase.

## Runtime shape

The supported path is:

```text
TUI input
  -> SessionPrompt journal + orchestration
  -> ephemeral Codex app-server
  -> private host MCP gateway
  -> cyberful-os / browser / ZAP / variables / question / handoff
  -> workarea artifacts
  -> validated successor
```

Codex app-server is the complete model-execution boundary. The TUI has no
alternate inference route or session-level executor selection.

Important host services under `cyberful/src` include:

- `Config.Service` for project and host policy;
- `SessionPrompt.Service` for journal writes, input delivery, and Codex-chain execution;
- `SessionStatus` and `SessionVariable` for durable control state;
- the phase runtime under `src/subsystem/` for app-server, budgets, native delegation, steering, handoff, and transcripts;
- the gateway under `src/subsystem/gateway/` for approved MCP capabilities.

The session journal records user input and the public projection of Codex phase
activity. It does not carry a transport choice.

## Phase lifecycle

For each sequential phase the orchestrator:

1. resolves the repository persona, shared Cyberful developer instruction, required artifact, and wall-clock budget;
2. creates a temporary Codex home and private gateway definition;
3. starts `codex app-server` over stdio;
4. starts one thread and one turn;
5. maps public text, tool activity, and delegated-actor lifecycle into TUI events and the phase transcript;
6. forwards live user steering and TUI-backed questions;
7. validates the required artifact and constrained `handoff` request;
8. proves the process and gateway tree have exited, then seals the final artifact with a host-generated
   SHA-256 manifest before launching the successor.

The host always runs one phase process at a time. Recon, Exploit, and Hacker can
permit native direct Codex children through persona metadata when the resolved
effort is Ultra; those children do not become host phases or own handoffs.
The subsystem activity interface represents actor identity, parentage, state,
and stable transitions independently of Codex. Each run owns its actor registry,
and the TUI scopes grouping and call pairing by subsystem descriptor so future
concurrent subsystem implementations cannot merge their activity accidentally.

## Gateway and security tools

Each phase receives one host-owned MCP gateway. It proxies only the tools
approved for that phase from cyberful-os, browser, and ZAP, and implements session
variables, human questions, and the phase-specific handoff. Personal Codex MCP
configuration and plugins do not enter the temporary runtime.

The browser uses a host-managed profile and is routed through the shared,
headless ZAP engagement container by default. Every phase owns one gateway and
browser route. Native Codex children call through that same gateway and share
the phase workarea, cyberful-os container, browser, ZAP state, and egress.

Gateway secrets are materialized in owner-only temporary files rather than
Codex process arguments. ZAP bridge containers are named and labelled per
gateway, removed explicitly when it closes, and swept again when the engagement
ends.

## Host extensions

External host plugins remain opt-in for behavior such as events, commands, and
shell environment shaping. They cannot perform model execution.

## Verification

Run `bun typecheck` from each package for type checking and
`bun run build` for the application bundle. MCP smoke tests should verify cyberful-os command
execution, browser navigation through ZAP, shared history, and bridge discovery through the gateway.
