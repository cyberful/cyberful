# Local fallback inference

Cyberful can optionally connect an operator-owned, loopback-only Responses API
server to a run. Codex remains the primary agentic subsystem. The local server
is a bounded delegate for authorized operations the primary cannot execute and
the owner of one automatic recovery when a primary execution fails recoverably.
It is not a user-selectable replacement backend or an independent workflow.

Fallback inherits the phase workarea, engagement scope, gateway controls, rate
limits, CAPTCHA circuit breaker, human decisions, and remaining active budget.
It never expands authorization. Its compact tool surface reduces prefill and
catalog noise; it is not a security sandbox because shell remains intentionally
general.

## Configure the server

Create `fallback-server.yaml` in the directory from which Cyberful is launched:

```yaml
version: 1
enabled: true
protocol: openai-responses
base_url: http://127.0.0.1:8000/v1
model: deepseek-v4-flash
api_key_env: CYBERFUL_FALLBACK_API_KEY # optional
system_prompt: |
  You are the local fallback controller for an authorized security test.
  Complete the supplied bounded operation inside the exact engagement scope.
```

The source checkout provides this ds4-compatible configuration at the repository
root. Start ds4 before `make run`, for example:

```sh
./ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192
```

Cyberful reads and validates the file once when the run starts, before creating
workers. `base_url` must be an HTTP or HTTPS loopback URL at the `/v1` root;
credentials, query strings, fragments, remote hosts, inline secrets, unknown
fields, and system prompts over 8 KiB are rejected. When `api_key_env` is
present, the named uppercase environment variable must exist. Its value stays
host-side. At execution time Cyberful appends its embedded target-content trust
boundary to the configured `system_prompt`; it does not forward the primary
persona, delegation policy, or first-party skill catalog.

Availability is frozen for the complete run:

- a missing file emits one run-level warning, records `disabled/missing`, and
  exposes neither the delegation tool nor its nudge;
- `enabled: false` records intentional disablement silently and also omits both;
- an invalid or unsafe file stops startup;
- an unreachable configured server emits the preflight warning and remains
  unavailable, with no background retry and no tool or nudge;
- a server that disappears after successful preflight makes that invocation
  return `fallback_unavailable`; provider request and stream retries remain zero.

The server must implement the OpenAI Responses wire protocol, including working
tool calls. [antirez/ds4](https://github.com/antirez/ds4) is the default. Other
operator-managed runtimes such as
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
are suitable only when their `/v1/responses` implementation and tool calling are
compatible; a generic HTTP or chat-completions endpoint is insufficient.

## Autonomous delegation

After successful preflight, the primary receives this dynamic host tool:

```text
delegate_to_fallback_inference({
  task: string,
  success_criteria: string,
  relevant_artifacts?: string[] // workarea-relative paths only
})
```

The primary also receives a conditional nudge: if an authorized action needs a
more aggressive approach and the primary cannot proceed, it should delegate the
bounded operation autonomously. Work the primary can execute normally remains
in the primary session. The operator does not select fallback manually.

Arguments are validated before Cyberful reserves an attempt index or starts a
server. In particular, `relevant_artifacts` rejects absolute paths and paths that
escape the workarea, so a corrected retry remains possible after invalid input.
Valid calls are serialized. They have no numeric cap while phase budget remains;
each receives a fresh local process, gateway, and transcript such as
`fallback-assist-1`, `fallback-assist-2`, and so on.

An assist uses the default-deny `fallback-assist` profile and returns a concise
result and evidence paths to the suspended primary. It cannot call `handoff`,
does not receive `delegate_to_fallback_inference`, and therefore cannot recurse.
The primary retains responsibility for the phase deliverable and handoff.
While an assist or recovery is running, the TUI marks its host-owned actor in
orange and labels the numbered attempt explicitly. Completion and failure retain
their normal green or red lifecycle state, while attributed fallback work keeps
the orange label.

## Automatic recovery

Cyberful evaluates recovery only after it has completely collected the primary
process, gateway, effective summary, required deliverable, and handoff. It
records one or more deterministic reasons:

- `provider_failure` for a structured or generic provider failure;
- `empty_summary` when the effective summary is empty;
- `missing_deliverable` when the required phase artifact is absent;
- `missing_handoff` when no required handoff was recorded;
- `invalid_handoff` when a recorded handoff violates the phase contract.

Any of those reasons may start exactly one non-recursive recovery for that
primary execution. Cyber-threat policy classification, including
`codexErrorInfo === "cyberPolicy"`, is one source of `provider_failure`, not the
only trigger. Cyberful does not start recovery for cancellation, host shutdown,
budget exhaustion, setup or spawn failure, a primary gateway that has not exited,
or host cleanup, artifact sealing, and readiness errors. It never automatically
retries a failed recovery.

An eligible recovery starts a fresh local process, nonce, `fallback-recovery`
gateway, handoff signal, and transcript. It receives the exact remaining active
phase budget and a sanitized capsule capped at 16 KiB. The capsule contains the
phase objective, required deliverable, checkpoint reference, deterministic
reasons, public provider state, incomplete-operation warning, and structured
error code. It excludes the full transcript, hidden reasoning, credentials,
secrets, and raw operational payloads. The recovery verifies possible prior
effects before replay, may complete the required handoff, cannot invoke fallback,
and does not replace the preserved original provider error.

## Approval continuity

One in-memory ledger belongs to exactly one run phase. The first human decision
for an exact question envelope is authoritative across primary, assist, and
recovery sessions. Accepted answers are replayed without another prompt and
rejections remain rejected. A differently shaped operation is new and must ask
the human. The ledger is discarded when the phase ends and cannot authorize
another phase or run.

## Compact gateway profiles

`fallback-assist` and `fallback-recovery` are default-deny at both tool listing
and direct-call boundaries. Assist eagerly receives only shell and compact
evidence/discovery tools from cyberful-os; it can query a narrow
`tool_inventory` category on demand and execute the selected command through the
already-authorized shell. Recovery additionally receives isolated tools carrying
the neutral `active` role because it may own the complete interrupted phase.
Both profiles explicitly include browser interaction, active ZAP operations,
CAPTCHA/question flow, rate limits, and circuit breakers. Recovery alone
receives `handoff`.

Assist omits eager dedicated command schemas; recovery still excludes DNS,
subdomain enumeration, host and port scanning, content discovery,
fingerprinting, passive inventory, and report generators. Because shell remains
general, the profile is an interface reduction rather than a security boundary.

## Public state and evidence

Primary and fallback transcripts are separate:

```text
session-ses_....expert-hacker.jsonl
session-ses_....expert-hacker.fallback-assist-1.jsonl
session-ses_....expert-hacker.fallback-assist-2.jsonl
session-ses_....expert-hacker.fallback-recovery-1.jsonl
```

Runtime manifest version 2 records every invocation with its attempt number,
adapter, model, instruction override mode, outcome, and transcript. Assist entries
use `mode: assist` and `trigger: model_delegation`; recovery uses
`mode: recovery`, `trigger: primary_failure`, and the `reasons` list. The public
phase status also records server state and the `recovered` flag. Neither surface
stores an API key, base URL, or configured system prompt.

Run the real loopback lifecycle contract with:

```sh
make test-network
```

The network test performs multiple delegations and a non-`cyberPolicy` recovery.
The ordinary suites cover missing/disabled/unreachable configuration, argument
retry, serialization, provider classes, output-contract reasons, exclusion
conditions, approval replay, budget ownership, gateway lifecycle, recursion
prevention, tool filtering, recovery advancement, and original-error preservation.
