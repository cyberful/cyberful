# Cyberful TUI Architecture

The terminal application is a local control plane around Codex as its primary
model executor. Session storage, orchestration, policy, MCP lifecycle, and
reporting are host responsibilities; primary model reasoning occurs in one
ephemeral Codex process per phase. An optional operator-owned loopback Responses
server can run a bounded helper or one-shot recovery through the same subsystem
contract.

## Runtime shape

The supported path is:

```text
TUI input
  -> SessionPrompt journal + orchestration
  -> ephemeral Codex app-server
  -> private host MCP gateway
  -> read-only source store / Code Graph / cyberful-os / browser / ZAP / variables / question / handoff
  -> workarea artifacts
  -> validated successor

Structured terminal cyberPolicy failure
  -> primary process and gateway fully reaped
  -> one local fallback recovery with an aggressive-recovery gateway
  -> validated deliverable and handoff, or preserved dual failure
```

Codex app-server owns the normal phase path. The TUI has no session-level
executor selector. Cyberful loads `fallback-server.yaml` once from the launch
directory and makes the local route available only after a successful loopback
preflight; it is never discovered from a workarea.

Important host services under `cyberful/src` include:

- `Config.Service` for project and host policy;
- `SessionPrompt.Service` for journal writes, input delivery, and Codex-chain execution;
- `SessionStatus` and `SessionVariable` for durable control state;
- the phase runtime under `src/subsystem/` for app-server, budgets, native delegation, steering, handoff, and transcripts;
- the gateway under `src/subsystem/gateway/` for approved MCP capabilities.

The session journal records user input and the public projection of subsystem
activity. Separate fallback transcripts and host-owned runtime manifests record
profile, trigger, adapter, model, server state, result, and recovery status without
keys or the configured system prompt.

## Phase lifecycle

For each sequential phase the orchestrator:

1. resolves the repository persona, shared Cyberful developer instruction, required artifact, and wall-clock budget;
2. creates a temporary Codex home and private gateway definition;
3. starts `codex app-server` over stdio;
4. starts one thread and one turn;
5. maps public text, tool activity, and delegated-actor lifecycle into TUI events and the phase transcript;
6. forwards live user steering and TUI-backed questions, preserving exact
   accepted and declined decisions in a phase-confined approval ledger;
7. validates the required artifact and constrained `handoff` request;
8. proves the process and gateway tree have exited, then seals the final artifact with a host-generated
   SHA-256 manifest before launching the successor.

When configured, one voluntary helper may temporarily suspend the primary turn,
use an `aggressive-assist` gateway, and return a compact result without owning
the phase handoff. Only a terminal failed turn classified structurally as
`codexErrorInfo === "cyberPolicy"` can trigger automatic recovery. Cyberful
first collects the primary process and gateway, then starts one fresh local
process, nonce, gateway, and transcript in the same phase, workarea, scope, and
remaining active budget. The recovery receives a sanitized capsule capped at
16 KiB and may own the handoff; it cannot recursively invoke fallback. Approval
waits remain outside the active budget.

Both fallback profiles use default-deny, versioned first-party tool sets. They retain
active security, shell, evidence, browser, approval, rate-limit, and
circuit-breaker controls while omitting recon inventory and report generators
to reduce prefill noise. `handoff` appears only in recovery. Because shell
remains general, this selection is an interface reduction rather than a
security boundary.

The phase runner supplies Markdown cleanup with only the required deliverable
path; it never traverses the complete workarea. Code Audit also verifies a
host-keyed, full-inventory graph readiness record before accepting
`index → trace`, binding the post-gateway source preflight, graph snapshot, and
coverage rows to the transition. Attack and Verify can each create a separate
mutable runtime lab. Dependency bootstrap mounts manifests only; after that
networked container exits, the host materializes source for offline loopback
execution in the phase-owned cyberful-os container and removes the lab after
the container stops.

The host always runs one phase process at a time. Selected Pentest and Code
Audit personas can permit native direct Codex children when the resolved
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

Pentest uses a host-managed browser profile routed through its shared headless
ZAP engagement by default. Code Audit has neither browser nor ZAP target
traffic; its cyberful-os container is phase-owned and offline. Native Codex
children call through the same phase gateway and share its workarea, containers,
and network policy.

Gateway secrets are materialized in owner-only temporary files rather than
Codex process arguments. ZAP bridge containers are named and labelled per
gateway, removed explicitly when it closes, and swept again when the engagement
ends.

Repository imports and deterministic source snapshots live in an owner-only
application-data store keyed by canonical workarea identity, outside Codex's
writable root. The gateway exposes only virtual read-only source operations.
The import HMAC key is durable for that workarea/import and separate from the
session finding-ledger key. Target repository `AGENTS.md`, skills, prompts, and
similar instruction-shaped content remain untrusted evidence and never join
the first-party runtime instruction chain.

## Host extensions

External host plugins remain opt-in for behavior such as events, commands, and
shell environment shaping. They cannot perform model execution.

## Verification

Run `bun typecheck` from each package for type checking and
`bun run build` for the application bundle. MCP smoke tests should verify cyberful-os command
execution, browser navigation through ZAP, shared history, and bridge discovery through the gateway.
