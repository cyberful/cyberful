# How phases work

Cyberful breaks a security job into clear phases. Each phase starts with a fresh
in-process Pi worker owner and sees only the tools allowed for that part of the
job.

```text
required artifact → root handoff or budget cutoff → host validation → owner shutdown/gateway exit → next phase
```

A phase cannot move forward just by saying it is done. Cyberful checks the
required file and handoff, saves the result, shuts down the current owner, and
only then starts the next phase. The real memory is the saved workarea and
evidence—not an invisible chat history.

The active-execution budget is also a phase boundary. If it expires before the
model requests a handoff, Cyberful cancels the AgentRun tree, shuts down its
in-process owner, reaps the gateway process group, verifies and seals the
required partial artifact, synthesizes the configured handoff, and starts the
successor in degraded mode. A missing artifact, failed seal, invalid handoff,
or gateway that cannot be proven stopped still halts the chain.

Blocking human decisions pause active-execution accounting rather than spending
that budget. The first pending question stops the budget timer of every
subscribed AgentRun; nested questions share the same controller, and only the
final reply or rejection restarts those timers. Cyberful does not send
`SIGSTOP`, suspend the host process, or freeze unrelated provider work already
in flight. Phase completion cannot bypass the pending request: cancellation or
full shutdown cancels the wait before deterministic owner and gateway cleanup.

The phase gateway carries that question as a standard MCP form elicitation with
a versioned Cyberful approval envelope. The requesting tool invocation remains
awaiting that elicitation while the shared controller pauses AgentRun budget
timers; its explicit MCP transport timeout remains an independent bound. The
same gateway completes the original tool call after `accept`, returns a
non-authorizing result after an explicit `decline`, and cancels it during phase
shutdown. The owner-only mailbox below mirrors that same request; it is not a
second phase-private question protocol.

The phase owner records every active `AgentRun`, its parent, the original phase
root, role, provider affinity, and termination. Gateway questions and dynamic
host tools may run for any currently active run in that phase; invented, stale,
or mismatched identities still fail closed. A decline is attributed to the
human only when the Cyberful selector adds its decision metadata. A transport
rejection without that attestation remains non-authorizing but is not reported
as an operator choice.

One approval envelope must not decide independent authorities. Requests that
differ by host, method, browser identity, credential, effect, risk, or traffic
bound use separate question calls and state those fields when applicable. A
tightly coupled informational batch may still share one envelope; backend,
OAuth, MCP, and credential permissions that can be accepted independently may
not. This keeps a single accept or decline from silently changing unrelated
scope or execution rights.

The Pi phase owner accepts approval only through MCP elicitation.
Provider-side permission channels, skill approval, and standalone model
requests cannot change host policy and fail closed at the gateway boundary.

Every root, subagent, and fallback run receives one complete, immutable Cyberful
system message. The provider-neutral compiler combines, in descending
authority, the invariant Cyberful contract, workflow authorization, phase
contract, persona, run-role overlay, explicitly trusted extensions, and the
skill catalog. Objective, attachments, explicit context, previous handoff, and
the historical input field named `system` remain user messages; that legacy
field is only an additional operator constraint and cannot replace the
Cyberful-owned system contract.

The compiler replaces exactly one authorization tag and one placeholder each
for persona, delegation policy, and workarea rules. The workflow, rather than a
reused persona, selects authorization, so Bug Bounty research phases retain
Bug Bounty authority while using Pentest Recon, Exploit, and Hacker personas.
Empty templates, personas, or workarea rules; duplicated placeholders;
unresolved placeholders; and unknown workflows fail before the worker starts.
Persona frontmatter is host metadata and never reaches the model.

The final prompt preserves scope, adversarial method, evidence and verification,
observation/conclusion/hypothesis separation, autonomous tool use, prompt
injection protection, workarea and skill contracts, delegation, fallback,
budgets, deliverables, findings, novelty, cleanup, handoff, completion, operator
communication, and the no-telemetry rule. Pi default prompts, hidden developer
messages, personal instructions, and ambient `~/.pi` or repository
configuration are disabled. Cyberful also refuses a provider adapter that
cannot carry a genuine system message.

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
base instructions therefore tell every AgentRun not to run
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
resolved novelty contract, provider/model route, system and component hashes,
skills used, delegation/fallback activity, and structured verdict counts. It
does not store credentials, full system messages, or reasoning text.

The derived values use `max(input - cacheRead, 0)` for uncached input,
`cacheRead / input` for reuse, `input / output` for amplification, uncached input
over input for churn, and reasoning output over total output for reasoning share.
Ratios are bounded and missing subsystem snapshots remain absent rather than
being fabricated as zeros for a phase.

For repository workflows, imported source and durable source snapshots live in
an owner-only host store outside the Pi workarea. The model receives no
native store path and reads source through bounded gateway calls. A durable
per-workarea import-attestation key stays in host state and is distinct from
the session finding-ledger key. Repository-provided agent files, skills, and
prompts are treated as target-controlled data rather than instructions.

Run ownership variables and provider credentials remain available only to the
owner-private host and gateway. Tool definitions expose phase capabilities, not
private gateway environment, so a model-side command such as `cyberful
--version` cannot inherit authority to finalize the active run. Shell temporary
files and the Bun install cache are likewise pinned beneath the phase-owned
`.cyberful-tmp` tree and removed with the phase.

## Delegated and fallback actors

Delegation is enabled only when both `settings.yaml` and the phase persona's
positive `subagents` metadata allow it. A child is a complete Pi `AgentRun` with
a fresh system message and a self-contained task capsule, not inherited private
reasoning or the parent's full transcript. It remains inside the owning phase's
workarea, gateway, browser/ZAP state, Ghidra project, skill catalog, traffic
policy, depth, concurrency, and budget limits. Children are attributed in the
activity feed but do not become host phases or separate Cyberful sessions.

A primary root or child can ask the host for a specific fallback task when it
predicts an imminent provider security-policy block. The host, not the model,
decides admission and routing. Proactive admissions share a session quota of 2%
by default. A normalized, provider-structured `security_policy_block` starts the
same fallback automatically without spending proactive quota; timeouts, rate
limits, authentication, capacity, network errors, malformed output, and generic
policy words do not.

A fallback root is also a complete Pi `AgentRun`. It receives the same
authorization, persona, tools, skill catalog, evidence rules, and ability to
create bounded descendants. Its entire tree keeps fallback provider affinity,
so no automatic route can ping-pong back to primary. A terminal fallback
provider error ends that branch and returns any partial result. Only the
original phase root owns `handoff`; all other actors return structured results
to their parent.

For automatic fallback, the coordinator reconstructs a minimal task capsule
from the blocked call: required artifacts, objective, expected result, and only
the explicit context needed to perform it. It does not copy private reasoning or
the complete transcript. The result returns to the blocked parent as a
host-owned tool result with a synthetic call identifier, after which the parent
continues.

Every child inherits the owning phase's authority and safety boundary and owns
its task through a verdict. It may begin passively, but runs safe in-scope
discriminators itself. Shared mutable resources are used non-overlapping or
serially; task partitioning and contention are not `UNTESTABLE` blockers.

`Escape` aborts the active AgentRun tree. While a blocking question
owns focus, one `Escape` only arms dismissal and a second deliberate press after
the prompt is visible confirms the decline; a carried or repeated input event
cannot decide it. `Ctrl+C` performs a full shutdown instead of being translated
into a decline, and cleans up Cyberful-owned AgentRun owners, control-plane
workers, gateways, containers, and bridges. A question belongs to the phase
that requested it; while pending it blocks that phase and its successors
without consuming active-execution budget. If the phase is cancelled before an
answer arrives, Cyberful retracts the question so it cannot authorize later
work.

All managed Docker resources carry `managed`, `owner-pid`, `run-owner`,
`session`, and `runtime` labels. Shutdown first asks the in-process Pi owner to
close its AgentRun tree and gateway bridge. The outer control-plane worker
process has a bounded teardown window, and Docker then gets an independent
cleanup window. The terminal performs a run-owner sweep after normal exit,
control-plane worker timeout, or crash; startup also reaps managed containers
whose owner PID is dead. Cleanup emits started, completed, or failed diagnostics
followed by `shutdown complete`.
