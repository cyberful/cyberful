# Local aggressive fallback inference

Cyberful can optionally connect an operator-owned, loopback-only Responses API
server to a run. Codex remains the primary agentic subsystem. The local server
is available for one bounded helper call per phase and for one deterministic
recovery when the primary provider terminally classifies a turn as a cyber
security-policy block.

The fallback exists so operators can use a local model with their own steering
for bounded authorized work that a hosted provider cannot complete. It inherits
the phase workarea, engagement scope, gateway controls, rate limits, CAPTCHA
circuit breaker, human decisions, and remaining active budget. It never expands
authorization. Its compact tool surface reduces prefill and catalog noise; it
is not a security sandbox because shell tools remain intentionally general.

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
  You are the local aggressive controller for an authorized security test.
  Complete the supplied bounded operation inside the exact engagement scope.
```

The source checkout already provides this ds4-compatible configuration at the
repository root. Start ds4 before `make run`, for example:

```sh
./ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192
```

Cyberful reads and validates this file once when the run starts, before any
workarea worker is created. `base_url` must be an HTTP or HTTPS loopback URL at
the `/v1` root; credentials, query strings, fragments, remote hosts, inline
secrets, unknown fields, and system prompts over 8 KiB are rejected. When
`api_key_env` is present, the named uppercase environment variable must exist.
Its value is used only for server requests and is excluded from the model's
shell environment. At execution time Cyberful appends its embedded
target-content trust boundary to the configured `system_prompt`. It does not
forward the primary phase persona, delegation policy, or first-party skill
catalog to the compact local session.

A missing file or `enabled: false` disables fallback. An invalid or unsafe file
stops startup. An unreachable server produces a warning, lets the primary run
start, and omits `aggressive_fallback_inference` for the complete run. Cyberful
does not probe again in the background. If a server that passed preflight later
disappears, the attempt returns `fallback_unavailable`; provider request and
stream retry counts remain zero.

The server must implement the OpenAI Responses wire protocol, including working
tool calls. [antirez/ds4](https://github.com/antirez/ds4) is the default: its
server exposes `/v1/models`, `/v1/responses`, Responses streaming, and tool
calls on port 8000. Other suitable operator-managed runtimes include
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
that expose a compatible `/v1/responses` endpoint. Availability of a generic
HTTP or chat-completions endpoint is not sufficient.

## Voluntary assist

When preflight succeeds, the primary subsystem receives this dynamic host tool:

```text
aggressive_fallback_inference({
  task: string,
  success_criteria: string,
  relevant_artifacts?: string[]
})
```

The call suspends the primary turn while a fresh local controller works in the
same workarea. The controller reads durable artifacts, uses the
`aggressive-assist` gateway profile, and returns a concise result plus evidence
paths. It cannot call `handoff`, does not see the fallback tool, and therefore
cannot recurse. The primary resumes and remains responsible for its deliverable.
Only one voluntary assist is allowed per phase.

## Deterministic recovery

Codex maps terminal provider failures to the shared `ProviderFailure` taxonomy.
Automatic recovery is triggered only when the completed turn contains
`codexErrorInfo === "cyberPolicy"`. Similar prose, preliminary safety buffering,
and generic provider errors do not trigger it.

After such a block Cyberful:

1. fully collects the primary process and gateway;
2. starts one local attempt with a fresh process, nonce, gateway, handoff signal,
   and transcript;
3. supplies a sanitized recovery capsule of at most 16 KiB and tells the model
   to read durable workarea evidence;
4. uses only the phase's remaining active budget; human waits remain excluded;
5. lets the `aggressive-recovery` controller finish the interrupted deliverable
   and own the required handoff;
6. never starts another fallback if this attempt fails.

The capsule includes the phase objective, required deliverable, checkpoint
reference, public provider state, incomplete-operation warning, and structured
error code. It excludes the full transcript, hidden reasoning, credentials,
secrets, and raw operational payloads. If prior work may already have produced
an effect, the recovery is instructed to verify observable state before replay.

## Approval continuity

One in-memory ledger belongs to exactly one run phase. The first human decision
for an exact question envelope is authoritative across primary, assist, and
recovery sessions. Accepted answers are replayed without another prompt and
rejections remain rejected. A differently shaped operation is new and must ask
the human. The ledger is discarded when the phase ends and cannot authorize
another phase or run.

## Compact gateway profiles

`aggressive-assist` and `aggressive-recovery` are default-deny at both tool
listing and direct-call boundaries. First-party versioned metadata selects
isolated shell, active HTTP and session testing, credential testing, fuzzing,
exploitation, binary/mobile/Active Directory work, browser interaction, active
ZAP operations, CAPTCHA/question flow, and evidence collection. Recovery alone
receives `handoff`.

DNS, subdomain enumeration, host and port scanning, content discovery,
fingerprinting, passive inventory, and report generators are excluded. The
profile preserves the parent phase's scope, gateway, rate limits, circuit
breaker, workarea, and runtime policy.

## Evidence and testing

Primary and fallback transcripts are separate:

```text
session-ses_....expert-hacker.jsonl
session-ses_....expert-hacker.fallback-assist-1.jsonl
session-ses_....expert-hacker.fallback-recovery-1.jsonl
```

Public phase status and `raw/phase-manifests/<workflow>/<phase>.runtime.json`
record the server state, mode, trigger, adapter, model, instruction override
mode, outcome, and `recovered` flag. They never record an API key or the complete
configured system prompt. Report phases read these manifests and disclose a
material fallback failure or unrecovered block as a coverage limitation.

Run the loopback Responses lifecycle contract with:

```sh
make test-network
```

The ordinary unit suite covers configuration, structured classification,
approval replay, budget ownership, gateway lifecycle, recursion prevention,
tool filtering, recovery advancement, and failure preservation.
