# How phases work

Cyberful breaks a security job into clear phases. Each phase starts with a fresh
in-process Pi worker owner and sees only the tools allowed for that part of the
job.

```text
active work → reserved closeout → artifact + root handoff → host validation → owner/gateway exit → next phase
```

A phase cannot move forward just by saying it is done. The `handoff` tool first
checks that the exact required deliverable is a non-empty regular file at the
workarea root. For live Exploit and Hacker it also takes one coherent snapshot
of the finding and hypothesis registries and validates their positive links.
A failed check returns inside the same AgentRun so it can be repaired; Cyberful
does not accept or record the handoff first. After owner shutdown it rechecks
the snapshot digest, seals the artifact, and starts the next phase. The real
memory is the saved workarea and evidence—not an invisible chat history.

The terminal outcome is one of `success`, `warning`, `blocked`, or `failed`.
Warnings are secondary, non-terminal degradations only. Exhausted provider
failures, missing deliverables, invalid handoffs, and unverified lifecycle
cleanup are `failed`; an operator shutdown or a budget stop that cannot advance
but violated no contract is `blocked`. The completion record identifies the
started phase, last phase, and every phase actually run. Its structured primary
failure contains phase, `provider`/`contract`/`lifecycle` origin, class,
optional code, and a bounded redacted detail.

Every sequential phase reserves the final part of its active-execution budget
for closeout. At that boundary Cyberful aborts the current provider turn without
ending the original root `AgentRun`, cancels children and pending delegations,
and inserts a host-owned closeout instruction into that same root. Target
traffic, scanners, lab execution, new research, and delegation are blocked.
Only local evidence reads, deliverable and ledger reconciliation, cleanup, and
`handoff` remain. The final deadline is still binding. An `exhausted`
hypothesis synthesis with no `OPEN` or `TESTING` entries enters this same
closeout path early; a `diversified` synthesis continues only with its recorded
discriminators. `budgets.json` configures
the reserve under `$closeout`: Pentest Brief uses three minutes; other Pentest
phases and every Bug Bounty and Code Audit phase use five. Ask has no reserve.
Legacy files default to three minutes for phases up to 30 minutes and five
above that, reduced with a warning when necessary.

If the final deadline expires before handoff, research phases may advance in
degraded mode only after Cyberful shuts down the owner, reaps the gateway, and
verifies and seals the partial artifact. Brief is stricter: a partial
`MISSION.md` remains a recovery checkpoint but never authorizes Recon without
an explicit handoff. A missing artifact, failed seal, invalid handoff, or
gateway that cannot be proven stopped halts the chain.

An `unavailable` provider failure, including `server_error`, transient
service-saturation signals such as `server_is_overloaded`, and an abnormal
Codex WebSocket closure (`1006`), can retry the same turn inside the same
`AgentRun`. Cyberful retains completed tool calls and tool results, removes only
the failed assistant message, and calls Pi continuation after exponential
full-jitter backoff. Token usage remains cumulative and text from a discarded
attempt is not published. One `PhaseBudgetClock` suspends active accounting from
`provider_retry: scheduled` through success, failure, timeout, or cancellation,
including backoff and provider response wait. Overlapping retries and approvals
extend the deadline once, not once per actor. Each attempt has
`attempt_timeout_ms` (ten minutes by default and at most ten minutes); timeout
aborts only that attempt and proceeds to the next retry. Total retry
compensation is one phase-wide pool configured by
`max_phase_extension_minutes` (15 minutes by default). Root, child, fallback,
concurrent retry, and phase-recovery waits share that pool and overlapping
intervals count once. Events, manifests, and `run-state.json` expose retry wait,
applied compensation, effective deadline, and cap state as distinct values:
`retry_wait_ms` remains the full union of retry intervals even after the cap,
while `retry_compensation_ms` stops at the configured cap. A transient retry
never invokes the security fallback. Receipt of the retry's assistant response
ends the suspended interval before any returned tool call executes; a slow tool
therefore consumes active phase time instead of being misclassified as provider
wait.

Blocking human decisions use the same phase clock and pause active-execution
accounting rather than spending that budget. The first pending question stops
the budget timer of every subscribed AgentRun; nested questions share the same
union interval, and only the final reply or rejection restarts those timers.
Cyberful does not send
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

Routine guidance has a separate control-plane operation:

```sh
cyberful --port 4096
# From another terminal:
cyberful session steer ses_... \
  --attach http://localhost:4096 \
  --message "Recheck the active page and continue."
```

The dedicated endpoint accepts text only and delivers it only to a busy root
AgentRun. It returns false if that run is no longer steerable and never falls
back to creating a new turn. It carries no provider, model, system prompt,
approval answer, or phase authority. A CAPTCHA or other blocking request must
still be resolved through its request ID in the approval mailbox.

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

Exploit and Hacker handoffs for Pentest and Bug Bounty carry a bounded,
host-owned snapshot of two separate authorities. The finding registry owns all
positive findings; the hypothesis registry owns investigation coverage,
negative and inconclusive results, phase transfers, and links to findings.
Confirmed and suspected hypotheses must link to current-run findings in the
same state. The inverse is deliberately not required: a valid confirmed
finding may coexist with a disproved, narrower impact or bypass hypothesis.
This preserves both facts instead of forcing an artificial one-to-one
inventory.

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
`get`. Exploit and Hacker cannot hand off while work is genuinely unfinished,
when a queued hypothesis targets the wrong successor, or when a positive
hypothesis has no matching current-run finding. A finding does not need a
positive hypothesis counterpart. Negative-only hypotheses do not alter the
finding registry. Verify must record the workflow's final decisions.

Writes take a cross-process workarea lock, re-read the latest revision under
that lock, and replace the JSON atomically. Invalid JSON, unknown schema
versions, unsafe paths, and symbolic links fail visibly without resetting the
record. Code Audit keeps Code Graph as its specialized authority and mirrors
its structured candidates and decisions into this common registry; a
pre-existing Code Graph import is historical until the active run examines it.

All three workflows use one session-wide hypothesis registry at
`raw/hypotheses/registry.json`, beginning in Brief for Pentest and Bug Bounty
and in Scope for Code Audit. Each entry has one stable ID, semantic fingerprint,
owner, phase, discriminator, candidate and omitted tools with typed reasons,
evidence and tool-call references, optional structured scope resolution,
finding link, and transition history with closure reasons. The lifecycle is
`OPEN`, `TESTING`, `QUEUED`, `SUSPECTED`, `CONFIRMED`, `DISPROVED`,
`INCONCLUSIVE`, or `UNTESTABLE`. A hypothesis is recorded before its first
discriminating test, enters `TESTING` before that test or any retest, and is
updated immediately afterward. Executed dispositions (`SUSPECTED`, `CONFIRMED`,
`DISPROVED`, and `INCONCLUSIVE`) are accepted only from `TESTING`; unexecuted
work may move directly from `OPEN` to `QUEUED` or `UNTESTABLE`. `OPEN` and
`TESTING` block handoff; `QUEUED` carries an exact successor and next test. Positive
states link the separate finding authority. Closed hypotheses remain in the
session registry with their evidence and transition history; queuing and
reopening preserve the same ID. Report receives read-only access to the full
registry, so phase transitions do not discard hypotheses.

Bug Bounty research phases additionally require a qualitative contrarian
synthesis through the same `hypothesis` tool. This records meaningfully
different avenues or target-specific evidence that useful diversification is
exhausted. `hypothesis synthesize` is the only model-facing novelty contract.
Historical novelty and execution-ledger files remain readable diagnostic
evidence, but new runs neither publish those tools nor write new entries.

Browser calls and egress observations append redacted profile, origin,
route-family, method, action-family, transition, outcome, and HTTP status
metadata to
`raw/operations/surface-coverage.jsonl`, with a per-phase summary under
`raw/operations/surface-coverage/`. Recon uses the map to maximize real journeys;
Exploit and Hacker use remaining gaps as pivot candidates. Route breadth counts
as coverage, not as causal novelty. Recon requires each Brief profile marked
`READY` and `IN_SCOPE` to reach its declared origin and perform at least one
meaningful navigation or interaction; there is no arbitrary click or route quota.
ZAP and cyberful-os egress observations join the same map even when a result
also carries browser metadata. Summary version 2 groups methods, statuses, and
outcomes per route; `failed_only` contains only routes without a successful
observation. A valid HTTP denial remains an exercised surface, not a tool failure.

Legacy `raw/operations/execution-ledger/<phase>.jsonl` and novelty files remain
readable as historical evidence. Tool authorization and calls belong to
operational records; investigation questions belong only to the hypothesis
registry.

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

Large MCP catalogs are kept by the phase worker and loaded through the immediate
host-owned `tool_search` tool. The first provider request carries only essential
controls such as `skill_read`, `handoff`, eligible delegation/fallback controls,
explicitly eager dynamic tools, and `tool_search`. Searching by name, title, or
description adds the selected definitions cumulatively to that `AgentRun`;
`query: "*"` enumerates the complete authorized catalog with `limit` and the
returned cursor. Providers with native tool-search support receive these as
deferred definitions, while other providers receive only the selected schemas
on the next turn.

Search gives exact names and name prefixes absolute priority, then ranks
weighted coverage across name, label, and description. Infrastructure words
such as `tool`, `MCP`, `cyberful`, and `os` do not make every remaining query
word mandatory; descriptive requests such as `shell command execution
cyberful-os` therefore still resolve `shell`.

This changes payload size, not authority. Every authorized browser,
cyberful-os, Ghidra, and ZAP operation remains searchable, including the full
ZAP catalog, and the gateway rechecks policy when the tool executes. Loaded
definitions are private to one root, child, or fallback run and are not
implicitly inherited by another.

Long phases bound provider input independently for every root, child, and
fallback `AgentRun`. Before each Pi turn, `transformContext` estimates the
immutable system prompt, loaded tool schemas, messages, and projected tool
results. It uses a route-local operational window rather than assuming the
model's theoretical capacity is usable. The default is the smaller of the
trusted Pi catalog limit and 256K; rotation starts at 75% and targets 35%.

Catalog capacity, an optional configured operational limit, and a session/route
upper bound learned from provider rejection remain distinct. Built-in
`context_window` settings may restrict Pi's catalog but never enlarge it.
`run_started`, terminal metadata, run state, and phase manifests expose the
catalog, configured, trusted, operational, observed, and effective values.

At a safe response boundary, Cyberful first writes selected complete tool
results as owner-only SHA-256-bound JSON under `raw/context-tool-results/`.
This deterministic archival retains call IDs and bounded useful excerpts in
active memory. A pass with no candidates is a `noop`, not a rotation failure.
The append-only session transcript remains the complete evidence record.

A tool-free summarizer then emits a strictly validated checkpoint of at most
8,192 tokens. Its structured state covers the objective, phase, decisions and
reasons, verified facts, supported hypothesis/finding/test references,
completed and open work, blockers, failed attempts, mistakes not to repeat, and
next actions. Free-form `working_notes` and `what_i_would_do_next` retain useful
continuity without becoming authoritative evidence. Referenced IDs and paths
must already occur in source context, and all strings are redacted.

The owner-only, versioned JSON under `raw/context-summaries/` records generation,
source counts and estimate, summarizer route/model/effort, evidence references,
and SHA-256. Only after parsing, persistence, and size validation does the host
atomically replace `agent.state.messages`.

The replacement is deliberately small: the checkpoint followed by the newest
complete suffix that fits the remaining target budget. Cyberful walks backward
from the latest message and starts the suffix only at a user or assistant
boundary, never at a tool result. Assistant tool calls and their results remain
one complete group. This may split one long autonomous operator turn: the
settled prefix is represented by the checkpoint while only its recent work is
re-injected. Older checkpoints do not accumulate, and the append-only transcript
remains the complete history.

The operational window is the soft working limit. A separate hard input limit
subtracts a fixed continuation reserve, up to 16,384 tokens and the model's
maximum output, from the trusted route window. A replacement above the target
but below the hard limit is installed with `target_unreachable`; it does not
fail merely because it remains above the soft trigger. `active_tail_too_large`
is reserved for the exceptional case where even checkpoint plus fixed context
cannot fit below the hard limit. The phase then receives one recovery attempt
on the same model route, with an explicit instruction to reconcile every
hypothesis before continuing.

The summarizer defaults to the active route at `medium` effort. It can select a
different declared route. A context rejection permits one retry on the same
route with a 50% smaller source, followed by one active-route attempt only when
the configured route differs. It has no tools and never invokes the security
fallback. A failed generation leaves memory unchanged, stores its generation
hash, and latches until a new
operator message or at least 8K of new context arrives.

A structured `context_length_exceeded` lowers the effective session/route bound
to `min(current, floor(failed_input × 0.80))`, removes only the failed assistant
message, rotates in emergency mode, and retries generation once. A second
rejection terminates as `context_rotation_failed`. Generic provider retry is
not entered and completed tools are not executed again.

New `context_rotation` events report `started`, `completed`, `partial`, or
`failed`, generation, all limits and provenance, source/active/summarized
message counts, whether the suffix split a turn, token estimates, checkpoint,
and per-attempt summarizer usage. Historical `context_compaction` events remain
readable, and deterministic tool-result archival retains its existing event
contract.

The gateway stops before the next phase starts, so phase-local tool
registrations do not leak across phases. One explicitly engagement-owned
cyberful-os container carries the declared cyberful-os, ZAP, and Ghidra state;
the EVM runtime remains separate. The host fixes container networking before
the first phase and guarantees terminal cleanup. Ghidra's protected project
store remains on disk by design so a later engagement instance for the same
workarea can reopen analysis and annotations.

Before closing upstream MCP clients, the gateway captures the exact PID, PPID,
start timestamp, and command identities of only the processes it spawned.
Normal SDK close runs first. Surviving identities are recorded before a bounded
`SIGTERM`/`SIGKILL` fallback, and a PID is signalled only if its start timestamp
and command still match. This proves ownership across reparenting, avoids PID
reuse and concurrent-run collisions, and makes an unreaped process a lifecycle
failure rather than silently advancing.

## Runtime observability

Each phase writes a host-owned runtime manifest with its termination, subsystem
failure classification, subsystem-neutral usage totals, context-churn metrics,
resolved novelty contract, provider/model route, system and component hashes,
skills used, delegation/fallback activity, structured verdict counts, initial
budget, closeout reserve, approval wait, full retry wait, applied retry
compensation, effective deadline, and retry-compensation cap state. It does not
store credentials, full system messages, or reasoning text.

The owner creates the phase transcript with mode `0600` before execution and
serially appends every redacted event as it arrives. The final host-owned status
is appended through the same queue. An interruption therefore leaves a valid
partial audit record without retaining or rewriting the whole transcript in
memory.

Provider-neutral derived values treat provider `input`, cache reads, and cache
writes as disjoint prompt components. `totalPromptInput` is
`input + cache.read + cache.write`; `uncachedInput` is
`input + cache.write` because creating a cache entry processes new context.
Cache reuse is `cache.read / totalPromptInput`, input amplification is
`totalPromptInput / output`, churn is
`uncachedInput / totalPromptInput`, and reasoning share remains reasoning output
over total output. Ratios are bounded and missing subsystem snapshots remain
absent rather than being fabricated as zeros for a phase.

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
Each `delegate_task` call carries a host-owned `sourceCallID` into its child.
It also receives a host-validated immutable display identity before spawn.
The parent may propose a short slug and one emoji; otherwise the host derives
them deterministically from the task and resolves collisions. The TUI renders
the identity as `@{👾 api-monster}`, while run IDs remain ownership keys.
The TUI folds that child's lifecycle into the originating card and shows the
run ID, provider/model, elapsed time, last activity, tool count, terminal state,
and structured failure. Unassociated actors remain independent rows.
When global or persona capacity is temporarily full, delegation waits in a
cancellable FIFO admission queue instead of failing immediately.
`delegation_status` reports active and available slots, queued admissions,
remaining starts, and depth limits. The default global concurrency is five;
the shared Pentest and Bug Bounty personas admit up to three direct Recon
subagents and five direct Exploit or Hacker subagents.
Every delegation names one workarea-relative `output_artifact`, and its child
deadline is the smaller of the remaining phase budget and
`agent.subagents.timeout_minutes` (30 minutes by default). Each child reserves
the same configured closeout interval before that deadline, stops research,
cancels only its descendants, and receives its exact `output_artifact` for
local reconciliation. Child closeout does not put the root or phase in closeout.
Timeout and provider failure still return the artifact path and whether partial
bytes exist.
The child provider and reasoning profile are independently configured through
`agent.subagents.provider` and `agent.subagents.reasoning_effort`; defaults are
the `openai-codex/gpt-5.6-sol` route at `high`. A fallback-affine tree cannot
change provider.

Every hypothesis stores authenticated `ownerRunID`, display metadata, and an
append-only ownership transition history. When a child terminates, the single
registry writer atomically transfers its nonterminal work to the nearest live
ancestor and returns recovered IDs and next steps. Phase recovery acquires
otherwise stranded active work. Handoff fails closed if active work has no
live owner.

`raw/operations/run-state.json` atomically materializes the current phase,
`work` or `closeout` mode, effective deadline, closeout reserve and remaining
time, last durable progress, root/child state, full retry wait, applied
compensation and cap, failure, and active budget remaining. Each actor also
records the configured and effective reasoning effort. The portable `ultra`
profile resolves to the strongest Pi-supported level for that provider/model
route; for GPT-5.6 Sol that is currently `max`.
It is the bounded operator health view; transcripts remain evidence, not the
monitoring API. After the phase chain stops, the session finalizer updates the
same artifact with `closed` or `closed_with_cleanup_errors`, removed and
remaining disposable resources, and the verified cleanup timestamp.

After same-turn provider retries are exhausted, one retryable provider failure
may restart the whole phase under `agent.phase_recovery`. The old owner and
gateway must be proven closed first. The new root uses only remaining budget,
reads the durable recovery evidence, and uses the fallback route when configured
and enabled. Attempt-specific transcripts and runtime manifests preserve both
executions.

A main-route root or child can ask the host for a specific fallback task when it
predicts an imminent provider security-policy block. The host, not the model,
decides admission and routing. Proactive admissions share a session quota of 2%
by default. A normalized, provider-structured `security_policy_block` starts the
same fallback automatically without spending proactive quota; timeouts, rate
limits, authentication, capacity, network errors, malformed output, and generic
policy words do not.

A fallback root is also a complete Pi `AgentRun`. It receives the same
authorization, persona, tools, skill catalog, evidence rules, and ability to
create bounded descendants. Its entire tree keeps fallback provider affinity,
so no automatic route can ping-pong back to main. A terminal fallback
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

## Provider usage and runtime diagnostics

Every provider call appends one row to
`raw/operations/provider-usage.jsonl`, including run ancestry, role, route,
requested and effective reasoning, call kind, status, non-cached input, cache
read/write, generated output, reasoning, and telemetry completeness. Reasoning
is already part of generated output and is never added to canonical volume.
The ledger is authoritative for root/subagent, phase, fallback, route, model,
and session reconciliation; cumulative events are only a live view.

The prompt footer exposes one compact projection:
`R> i:2,03K c:1,22M g:50,13K | S> i:… c:… g:…`. `R` contains top-level,
recovery-root, and top-level fallback work; `S` contains delegated AgentRuns at
all depths. If the complete segment cannot fit, it is hidden rather than
wrapped or truncated.

Gateway, MCP, ZAP, and browser startup, connect, tool, timeout, and shutdown
failures append sanitized bounded V2 rows to
`raw/operations/runtime-diagnostics.jsonl`. Each row carries a stable
root-cause signature, outcome, blocking flag, count, timestamps, original byte
count, a short redacted preview, and a message hash. Credentials, cookies, URL
userinfo/query values, controls, bodies, prompts, documents, stack traces, and
full environments are excluded. Successful tool output is never interpreted
as a connection diagnostic. Routine lifecycle lines and explicit `TRACE`,
`DEBUG`, or `INFO` records remain informational even when stderr contains a
timestamp or prefix; stderr severity is interpreted together with the exit
outcome. The TUI distinguishes recovered retries, non-blocking tool failures,
degraded observability, and blocking lifecycle failures. Details are not
inserted into model context, and V1 rows remain readable.

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
`session`, and `runtime` labels, including the one engagement
`cyberful-os` container. Normal session closure reaps its exact deterministic
name and then performs three bounded label-based discovery/removal
passes. The final session-and-run-owner query must prove that no disposable
session resource remains. A survivor or an unavailable Docker inventory is a
terminal lifecycle error retained in `run-state.json`; a closed UI cannot
silently imply successful cleanup.

Full shutdown first asks the in-process Pi owner to close its AgentRun tree and
gateway bridge. The outer control-plane worker gets two minutes to unwind the
phase and its Docker runtimes. If that deadline expires, the terminal kills the
remaining process trees and reaps the exact last-known container snapshot
before awaiting run-label discovery. A final run-owner sweep catches late
creations; startup also reaps managed containers whose owner PID is dead.
Cleanup emits started, completed, or failed diagnostics followed by `shutdown
complete`.
