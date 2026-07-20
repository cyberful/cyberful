# How phases work

Cyberful breaks a security job into clear phases. Each phase starts with a fresh
Codex process and sees only the tools allowed for that part of the job.

```text
required artifact → handoff request or budget cutoff → host validation → process/gateway exit → next phase
```

A phase cannot move forward just by saying it is done. Cyberful checks the
required file and handoff, saves the result, closes the current process, and
only then starts the next phase. The real memory is the saved workarea and
evidence—not an invisible chat history.

The active-execution budget is also a phase boundary. If it expires before the model
requests a handoff, Cyberful stops and reaps the process and gateway, verifies
and seals the required partial artifact, synthesizes the configured handoff,
and starts the successor in degraded mode. A missing artifact, failed seal,
invalid handoff, or gateway that cannot be proven stopped still halts the chain.

Blocking human decisions suspend the complete active phase rather than spending
that budget. The first pending question freezes the deadline and, on POSIX,
stops the Codex process group and its descendants. Nested questions share the
same gate; only the final reply or rejection resumes the group. No handoff or
successor can advance while the request remains pending. Cancellation and full
shutdown resume a stopped group before bounded cleanup so it cannot become an
orphan.

The phase gateway carries that question as a standard MCP form elicitation with
a versioned Cyberful approval envelope. Codex pauses the gateway tool's active
timer while the elicitation is pending, so the normal 600-second MCP tool limit
still bounds operational work but does not bound human response time. The same
gateway resumes the original tool call after `accept`, returns a non-authorizing
result after `decline`, and cancels it during phase shutdown. There is no
separate file-based question transport.

The app-server thread uses a granular approval policy that enables only MCP
elicitations. Sandbox escalation, rules, skill approval, and standalone
permission requests remain disabled and continue to fail closed at the host
boundary.

Every primary thread receives the phase persona, delegation policy, shared
behavioral posture, and finally Cyberful's embedded trust boundary as developer
instructions. The last layer classifies target-controlled pages, responses,
tool output, and persisted target data as evidence rather than instructions.

Every pending request is also written to an owner-only local approval mailbox.
The TUI and an external operator resolve the same immutable request ID, and the
first valid decision wins. This lets a remotely directed coding assistant relay
the question and apply the human's selected option without converting ordinary
session steering into authorization:

```sh
cyberful approval list --session ses_... --format json
cyberful approval reply que_... --select '#1'
cyberful approval reject que_...
```

Use one `--select` per question; a selector may be a one-based option number,
an exact option label, or custom text only when the request permits it. Use
`--answers '[["Choice A","Choice B"]]'` for a multi-select answer. The mailbox
binds each decision to the session, request envelope, and live owner process;
stale requests remain inspectable as orphaned but cannot authorize another run.
An assistant must submit a decision only after the human explicitly selects or
rejects that specific pending request; a generic instruction to continue is not
approval and must not be inferred as one.

Phase cleanup owns only the declared output. For Markdown, Cyberful passes the
single required deliverable path to the normalizer; it never recursively edits
the workarea. Imported repositories, snapshots, prior artifacts, and arbitrary
Markdown therefore cannot be changed as a side effect of another phase ending.

Code Audit has one additional transition invariant. Before `index → trace`, the
host revalidates the source boundary and compares a signed, full-inventory
readiness record with the current Code Graph snapshot and coverage rows. The
check runs only after the phase gateway is proven stopped. Failure keeps Trace
closed, including for a budget-generated handoff.

Pentest uses `brief → recon → exploit → hacker → verify → report`. Code Audit
uses `scope → index → trace → hunt → attack → verify → report`. The
[workflow guide](../user-guide/workflows.md) defines every artifact and gate.

## Tools and network access

The private gateway combines first-party host tools, bounded Code Graph
queries, cyberful-os, the isolated browser, and ZAP where the phase is eligible.
Keys and dynamic ports remain host-owned. Pentest receives the live-target
traffic route recorded by its mission. Code Audit remains offline: its Attack
and Verify phases can bootstrap dependencies in a source-blind disposable
container, then execute and attack the project on loopback inside cyberful-os.

The gateway stops before the next phase starts, so tool registrations, traffic
grants, and ephemeral credentials do not leak across phases.

## Local fallback sessions

When `fallback-server.yaml` passes its startup preflight, the primary subsystem
can call one `aggressive_fallback_inference` helper per phase. Cyberful suspends
the primary session while a new local controller works through a reduced,
default-deny `aggressive-assist` gateway. The helper cannot request handoff or
invoke itself; it returns a concise result and evidence references to the
primary session, which retains responsibility for the deliverable.

Automatic recovery is narrower. It runs once only after the terminal provider
failure is structurally classified as `security_policy_block`; buffering,
matching prose, and generic provider errors do not qualify. Cyberful first
collects the primary process and gateway, then starts a fresh local session and
`aggressive-recovery` gateway in the same run, phase, workarea, scope, and
remaining active budget. A sanitized recovery capsule describes the incomplete
operation and durable artifacts without copying the transcript, reasoning,
credentials, or raw payloads. Recovery can complete the phase handoff but
cannot recurse. Local sessions receive the configured compact system prompt
followed by the same embedded trust boundary; Cyberful does not forward the
primary phase persona or skill catalog.

Accepted and declined approvals are matched by their exact request envelope and
automatically reused only inside the same run and phase. A genuinely new action
still asks the human. Fallback sessions receive distinct transcripts, while a
host-owned runtime manifest records their public outcome without API keys or
the configured system prompt. See
[Local fallback inference](../runtimes/fallback-inference.md).

For repository workflows, imported source and durable source snapshots live in
an owner-only host store outside the Codex writable root. The model receives no
native store path and reads source through bounded gateway calls. A durable
per-workarea import-attestation key stays in host state and is distinct from
the session finding-ledger key. Repository-provided agent files, skills, and
prompts are treated as target-controlled data rather than instructions.

## Delegated actors

Native Codex delegation is permitted only when the phase persona has a positive
subagent budget and reasoning effort is `ultra`. Children receive
self-contained tasks without inherited conversation history and remain inside
the owning phase's workarea, gateway, browser/ZAP state, and traffic policy.
They are attributed in the activity feed but do not become host phases or
separate Cyberful sessions.

`Escape` aborts the active process and descendants. `Ctrl+C` performs a full
shutdown and cleans up Cyberful-owned workers, gateways, containers, and
bridges, including while a blocking question is visible. A question belongs to
the phase that requested it; while pending it blocks that phase and its
successors without consuming execution budget. If the phase is cancelled before
an answer arrives, Cyberful retracts the question so it cannot authorize later
work.
