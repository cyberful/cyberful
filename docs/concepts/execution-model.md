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
result after an explicit `decline`, and cancels it during phase shutdown. The
owner-only mailbox below mirrors that same request; it is not a second
phase-private question protocol.

The app-server records every active parent and native-child thread/turn pair it
observes. Gateway questions and dynamic host tools may run for any currently
active pair in that phase; invented, stale, or mismatched identities still fail
closed. A decline is attributed to the human only when the Cyberful selector
adds its decision metadata. A transport rejection without that attestation
remains non-authorizing but is not reported as an operator choice.

One approval envelope must not decide independent authorities. Requests that
differ by host, method, browser identity, credential, effect, risk, or traffic
bound use separate question calls and state those fields when applicable. A
tightly coupled informational batch may still share one envelope; backend,
OAuth, MCP, and credential permissions that can be accepted independently may
not. This keeps a single accept or decline from silently changing unrelated
scope or execution rights.

The app-server thread uses a granular approval policy that enables only MCP
elicitations. Sandbox escalation, rules, skill approval, and standalone
permission requests remain disabled and continue to fail closed at the host
boundary.

Every primary thread replaces Codex's model-specific base instructions with one
rendered Cyberful template. The stable opening defines the common adversarial
posture and phase-execution behavior. The host then replaces exactly one
placeholder each for the selected hacker profile, calculated Codex delegation
policy, and workarea rules. The invariant target-content trust boundary is
written directly in the template. Rendering fails before process spawn when a
placeholder is missing, duplicated, or remains unresolved. Cyberful sends
`developerInstructions: null`; Codex may still add its own runtime-owned
developer messages for enabled native capabilities.

The template order moves from identity and judgment into progressively narrower
operational definitions. Its final trust boundary closes the contract by
classifying target-controlled pages, responses, tool output, and persisted
target data as evidence rather than instructions.

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

The workarea root is an artifact workspace, not a Git checkout. The rendered
base instructions therefore tell Codex and its direct subagents not to run
repository-level Git discovery or status commands at that root. A phase may use
Git only inside an explicitly materialized nested repository or disposable lab,
with that repository selected as the working directory.

Live-target phases expose a host-owned `test_object` ledger for synthetic target
state. Its append-only transitions are `planned → not_created`, or `planned →
created → oracle_checked/cleanup_attempted → cleaned/residual`. Handoff checks
only that every object has a terminal disposition. It does not convert an
explicit residual record into a block or broaden the approval policy. The
durable record is `raw/operations/test-object-lifecycle.jsonl`.

Exploit and Hacker handoffs for Pentest and Bug Bounty carry a structured,
mutually exclusive verdict inventory. Positive-evidence suspicion, an ambiguous
executed test, and a test that never ran are distinct host-validated states.
Untestable entries use a bounded blocker taxonomy and retain the exact next
step, so downstream phases can distinguish product evidence from a coverage gap.

Every workarea also owns an authoritative live finding registry at
`raw/findings/registry.json`. It keeps stable finding IDs and aliases, run
records, and chronological observations without promoting evidence from an old
run into the current one. Findings from an earlier run appear as historical
until the current run records an explicit `revisit`; hypotheses and backlog
items do not enter the registry until there is enough positive evidence for
`SUSPECTED`. That first record must also assign an evidence-bounded provisional
severity; `UNRATED` remains available only for historical data written before
this contract.

The registry separates technical state (`SUSPECTED`, `INCONCLUSIVE`,
`UNTESTABLE`, `CONFIRMED`, or `DISPROVED`), Verify disposition (`NOT_REVIEWED`,
`SURVIVES`, `REVISE`, or `DEMOTE`), Bug Bounty submission disposition, and
severity. Recon through Verify use the host-owned `finding` tool to `record`,
`revisit`, `update`, `alias`, `list`, or `get`; Report can only `list` and
`get`. Exploit and Hacker cannot hand off when their verdict inventory diverges
from the registry, and Verify must record the workflow's final decisions.

Writes take a cross-process workarea lock, re-read the latest revision under
that lock, and replace the JSON atomically. Invalid JSON, unknown schema
versions, unsafe paths, and symbolic links fail visibly without resetting the
record. Code Audit keeps Code Graph as its specialized authority and mirrors
its structured candidates and decisions into this common registry; a
pre-existing Code Graph import is historical until the active run examines it.

Bug Bounty research phases additionally receive a host-resolved qualitative
novelty contract from their budget file. The phase records falsifiable,
target-grounded hypotheses by semantic root-cause family. When the ledger sees
local convergence it emits one signal, after which the phase performs a
contrarian pivot and ends with a synthesis that either documents meaningfully
different avenues or explains with target evidence why diversification is
exhausted. There are no quotas, minimum family counts, consecutive-family caps,
or administrative calls needed to unlock handoff. Each phase ledger is stored
at `raw/operations/novelty/<phase>.jsonl`.

Browser calls also append redacted profile, origin, route-family, action-family,
transition, outcome, and status metadata to
`raw/operations/surface-coverage.jsonl`, with a per-phase summary under
`raw/operations/surface-coverage/`. Recon uses the map to maximize real journeys;
Exploit and Hacker use remaining gaps as pivot candidates. Route breadth counts
as coverage, not as causal novelty, and no route or click minimum blocks handoff.

Code Audit has one additional transition invariant. Before `index → trace`, the
host revalidates the source boundary and compares a signed, full-inventory
readiness record with the current Code Graph snapshot and coverage rows. The
check runs only after the phase gateway is proven stopped. Failure keeps Trace
closed, including for a budget-generated handoff.

Pentest and Bug Bounty Program use `brief → recon → exploit → hacker → verify → report`;
Bug Bounty has dedicated Brief, Verify, and Report policy while reusing the three
middle Pentest personas. Code Audit uses
`scope → index → trace → hunt → attack → verify → report`. The
[workflow guide](../user-guide/workflows.md) defines every artifact and gate.

## Tools and network access

The private gateway combines first-party host tools, bounded Code Graph
queries, cyberful-os, the isolated browser, ZAP, and Ghidra where the phase is eligible.
Keys and dynamic ports remain host-owned. Pentest and Bug Bounty Program receive
the live-target traffic route recorded by `MISSION.md`. Bug Bounty can additionally
share one engagement-owned Anvil container and compiler cache across Recon through
Verify. Its loopback endpoints and synthetic keys are lifecycle capabilities,
not an RPC proxy or method policy; direct Forge, Cast, shell, and public RPC use
remain governed by `MISSION.md`. Code Audit remains offline: its Attack
and Verify phases can bootstrap dependencies in a source-blind disposable
container, then execute and attack the project on loopback inside cyberful-os.

The gateway stops before the next phase starts, so phase-local tool registrations
and traffic grants do not leak across phases. The explicitly engagement-owned
ZAP, Ghidra, and EVM runtimes are the exceptions: their host owners carry only
the declared runtime state across eligible phases and guarantee terminal
container cleanup. Ghidra's protected project remains on disk by design so a
later instance for the same workarea can reopen analysis and annotations.

## Runtime observability

Each phase writes a host-owned runtime manifest with its termination, subsystem
failure classification, subsystem-neutral usage totals, context-churn metrics,
resolved novelty contract, Codex settings attestation, and structured verdict
counts. It does not store credentials, prompts, or reasoning text.

The derived values use `max(input - cacheRead, 0)` for uncached input,
`cacheRead / input` for reuse, `input / output` for amplification, uncached input
over input for churn, and reasoning output over total output for reasoning share.
Ratios are bounded and missing subsystem snapshots remain absent rather than
being fabricated as zeros for a phase.

For repository workflows, imported source and durable source snapshots live in
an owner-only host store outside the Codex writable root. The model receives no
native store path and reads source through bounded gateway calls. A durable
per-workarea import-attestation key stays in host state and is distinct from
the session finding-ledger key. Repository-provided agent files, skills, and
prompts are treated as target-controlled data rather than instructions.

Run ownership variables are removed from both one-shot and app-server model
process environments after subsystem overrides are merged. They remain available
only to the owner-private gateway environment, so a model-side command such as
`cyberful --version` cannot inherit authority to finalize the active run. Shell
temporary files and the Bun install cache are likewise pinned beneath the
phase-owned `.cyberful-tmp` tree and removed with the phase.

## Delegated actors

Native Codex delegation is permitted only when the phase persona has a positive
subagent budget and reasoning effort is `ultra`. Children receive
self-contained tasks without inherited conversation history and remain inside
the owning phase's workarea, gateway, browser/ZAP state, Ghidra project, and traffic policy.
They are attributed in the activity feed but do not become host phases or
separate Cyberful sessions.

A child inherits the owning phase's authority and safety boundary and owns its
task through a verdict. It may begin passively, but runs safe in-scope
discriminators itself. Shared mutable resources are used non-overlapping or
serially; task partitioning and contention are not `UNTESTABLE` blockers.

`Escape` aborts the active process and descendants. While a blocking question
owns focus, one `Escape` only arms dismissal and a second deliberate press after
the prompt is visible confirms the decline; a carried or repeated input event
cannot decide it. `Ctrl+C` performs a full shutdown instead of being translated
into a decline, and cleans up Cyberful-owned workers, gateways, containers, and
bridges. A question belongs to the phase that requested it; while pending it
blocks that phase and its
successors without consuming execution budget. If the phase is cancelled before
an answer arrives, Cyberful retracts the question so it cannot authorize later
work.

All managed Docker resources carry `managed`, `owner-pid`, `run-owner`,
`session`, and `runtime` labels. Shutdown gives the worker a bounded process
teardown window and then gives Docker an independent cleanup window. The
terminal performs a run-owner sweep after normal exit, worker timeout, or crash;
startup also reaps managed containers whose owner PID is dead. Cleanup emits
started, completed, or failed diagnostics followed by `shutdown complete`.
