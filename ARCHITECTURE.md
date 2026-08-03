# Cyberful TUI Architecture

The terminal application is a local control plane around Pi Agent. Session
storage, orchestration, policy, provider routing, MCP lifecycle, and reporting
are host responsibilities. Model reasoning occurs in complete, phase-scoped
`AgentRun` contexts.

## Runtime shape

The supported path is:

```text
TUI input
  -> session journal + workflow controller
  -> fresh phase-scoped in-process Pi worker owner
       -> root AgentRun on the primary provider
       -> bounded delegated AgentRun tree
       -> optional provider-affined fallback AgentRun tree
  -> private host MCP gateway
  -> source store / Code Graph / unified tooling container / browser / EVM / variables / question / handoff
  -> workarea artifacts
  -> root-only validated successor
```

`PiAgentSubsystem` is the only production implementation of the
`AgentSubsystem` contract. OpenAI Codex OAuth, OpenAI-compatible GLM, and other
reviewed adapters are inference providers inside Pi; they are not alternate
Cyberful runtimes. Provider, model, delegation bounds, fallback policy, and
trusted extension roots come from `settings.yaml`.

Important host services under `cyberful/src` include:

- `Settings` for strict operator-owned provider and runtime configuration;
- `SessionPrompt.Service` for journal writes, input delivery, and phase-chain execution;
- `SessionStatus` and `SessionVariable` for durable control state;
- the phase runtime under `src/subsystem/` for prompts, AgentRuns, budgets, delegation, fallback, steering, handoff, and transcripts;
- the gateway under `src/subsystem/gateway/` for approved MCP capabilities.

The session journal records user input and the public projection of subsystem
activity. Host-owned runtime and prompt manifests record role, parentage,
provider route, termination, normalized failures, usage, system-component
hashes, novelty policy, and verdict counts without credentials or private
reasoning.

## Phase lifecycle

For each sequential phase the orchestrator:

1. loads strict `settings.yaml`, the embedded base template, the workflow-scoped
   persona, the skill catalog, the required artifact, and the active-execution budget;
2. compiles one complete, immutable Cyberful system message and hashes every
   component before provider execution;
3. creates one phase-scoped in-process Pi worker owner and one private gateway connection;
4. starts the original root `AgentRun` on the resolved primary provider;
5. maps public text, tool activity, child lifecycle, fallback routing, and usage
   into TUI events and the redacted phase transcript;
6. forwards live user steering and TUI-backed questions while pausing the active
   budget for each pending human decision;
7. validates the required artifact and a constrained `handoff` request emitted
   only by the original root;
8. shuts down the complete AgentRun tree and gateway, then seals the final
   artifact with a host-generated SHA-256 manifest before starting the successor.

Root, delegated, and fallback runs are distinct Pi contexts. Every child gets a
fresh complete system message, the same authorization and persona, a bounded
task capsule, the phase tools and skill catalog, and no parent transcript.
Persona metadata plus `settings.yaml` bound depth, concurrency, and descendants.
Only the original phase root owns `handoff`.

Primary roots and children may request a specific proactive fallback task.
Cyberful admits those requests against the session quota and chooses the route.
A normalized structured `security_policy_block` from the primary provider can
also create a quota-exempt fallback. The fallback is a complete `AgentRun`; its
entire descendant tree remains affined to the fallback provider and cannot
automatically return to the primary route.

The phase runner normalizes Markdown only at the required deliverable path; it
never traverses the complete workarea. Code Audit additionally requires
host-verified source readiness plus a matching signed graph snapshot and
coverage record before `index → trace`. Attack and Verify may create separate
mutable runtime labs. Bootstrap mounts manifests only, project execution is
offline and loopback-only, and the phase-owned lab is removed after use.

## Prompt and trust boundary

`AgentPromptCompiler` combines the immutable Cyberful contract, workflow
authorization, phase contract, persona, role overlay, explicitly trusted
extensions, and user objective in a fixed authority order. It rejects empty
components, unknown persona metadata, unresolved placeholders, and duplicate
placeholder use before starting the worker.

Cyberful sends exactly one authentic provider system message. Persona
frontmatter remains host metadata, while the initial user message contains the
objective, explicit context, attachments, and prior handoff. Later steering is
also user input and never mutates the run's system message.

First-party personas, skills, budgets, and instructions are embedded from
`cyberful/builtin/`. Pi does not discover prompts, skills, tools, or plugins from
its home directory, target repository, or ambient agent configuration.
Operator extensions load only from trusted roots explicitly listed in
`settings.yaml`. Repository instruction-shaped content remains untrusted audit
evidence.

## Gateway and security tools

Each phase receives one host-owned MCP gateway connection. It exposes only the
tools approved for the workflow and phase from cyberful-os, browser, ZAP,
Ghidra, Code Graph, session variables, human questions, and handoff. Provider
and model selection cannot add MCP servers or weaken tool policy.

Pentest uses a host-managed browser profile routed through its engagement ZAP
by default. One unified tooling container holds cyberful-os, ZAP, and Ghidra for
the complete engagement. Code Audit creates that same image with
`--network none` and does not start ZAP. Every AgentRun in the phase uses the
same workarea, gateway capabilities, engagement containers, and fixed network
policy, with handoff authorization enforced again at the gateway.

Gateway credentials and private environment remain host-owned and never enter
model context, transcripts, or manifests. ZAP and Ghidra bridges are fresh
`docker exec` stdio processes inside the engagement container, not Docker
resources of their own. The Ghidra JVM persists between eligible phases; its
host-owned project reopens by canonical workarea identity.

Repository imports and deterministic source snapshots live in an owner-only
application-data store outside the model-writable workarea. The gateway exposes
only bounded read-only source operations. The import HMAC key is durable for
that workarea/import and separate from the session finding-ledger key.

## Host extensions

External host plugins remain opt-in for behavior such as events, commands, and
shell environment shaping. They cannot perform model execution or alter the
provider and tool routes resolved by Cyberful.

## Verification

Run `make typecheck` for repository type checking, `make runtime-build
test-runtime` for the native tooling contract, and `make build` for standalone
binaries. Focused contracts cover system-message preservation,
provider security-block normalization, nested delegation, fallback affinity,
quota behavior, gateway ownership, and credential redaction. MCP integration
tiers verify cyberful-os command execution, browser navigation through ZAP,
Ghidra project restart persistence, and bridge discovery through the gateway.
