# Agent providers and fallback

Cyberful uses Pi Agent for every model-backed operation. `settings.yaml` selects
the inference providers used by Pi; it does not select a second agent runtime.
The file lives in the directory from which Cyberful is launched. If it is
missing, Cyberful creates an owner-only, secret-free default:

```yaml
version: 1

agent:
  subsystem: pi
  main_provider: openai-codex

  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2

  compaction:
    enabled: true
    trigger_percentage: 68

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000

  fallback:
    proactive:
      enabled: false
      percentage: 2
    automatic_security_block:
      enabled: false

  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.6-sol
      auth:
        type: subscription

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
```

At least one provider and a valid `main_provider` are required. Provider and
model selection is host-owned: an agent cannot add a route, choose its own
provider, or change the tool policy.

## AgentRun context compaction

`agent.compaction` protects every root, delegated, and fallback `AgentRun` from
exhausting its provider context during a long phase. Existing version 1 settings
that omit the section receive the defaults shown above.

`trigger_percentage` accepts 50 through 85 and defaults to 68. The effective
trigger is the lower of that percentage of `model.contextWindow` and the space
left after reserving the active maximum output plus a safety margin. Compaction
therefore starts before the advertised ratio when a model permits a large
response.

Cyberful does not truncate the tool or reduce its authority. The internal
AgentRun transcript retains the original messages, while `transformContext`
creates a smaller provider-only projection. Historical ZAP, browser,
cyberful-os, and host-tool results selected for virtualization are written
complete with owner-only permissions under
`raw/context-tool-results/<run>/<result>.json`. The projection contains a useful
excerpt, result state, byte count, workarea path, and SHA-256 identifier.
That projection is retained per `AgentRun`: later turns reuse the same artifact
references and compact messages, so an already-virtualized result does not
trigger another compaction merely because the authoritative transcript remains
large. Only newly accumulated context can cross the effective threshold again.

The original system prompt, operator messages, assistant decisions, hypotheses,
findings, handoffs, child-run structure, tool-call IDs, and call/result pairing
remain unchanged. Recent results are preferred over older ones; when one recent
result alone would exceed the safe context, Cyberful preserves it through the
same complete artifact and sends only its bounded projection.

If the provider still returns `context_length_exceeded`, Cyberful removes only
that failed assistant message, forces a more aggressive projection, and calls
`Agent.continue()` on the same run. Completed tools are not executed again.
This recovery has no backoff and is separate from transient provider retry.
Repeated failures against an unchanged context remain terminal instead of
looping.

The transcript records `context_compaction` events with `scheduled`, `started`,
`completed`, `recovered`, or `failed` state, proactive or emergency mode,
estimated tokens before and after, removed-message count, virtualized-result
count, and preserved-artifact count. The live timeline shows one compact,
informationally colored row for the final outcome; the intermediate
`scheduled` and `started` states remain available in the structured transcript
without appearing as warnings.

## Transient provider retry

`agent.retry` controls a global, same-turn retry for provider failures classified
as `unavailable`, including `server_error` and transient service-saturation
signals such as `server_is_overloaded`. An abnormal Codex WebSocket closure
(`1006`) uses the same recovery path. Existing version 1 settings that omit the
section receive the defaults shown above; no migration is required.

The runtime preserves the user message, successful assistant tool calls, and
their tool results, removes only the failed assistant message, and continues the
same `AgentRun`. Completed tools are therefore not executed again. Every attempt
still contributes to usage totals, while partial text from a discarded attempt
is not published.

Backoff is exponential with full jitter, bounded by `max_delay_ms`, and is
interrupted by cancellation, shutdown, or the phase budget. `max_retries` accepts
1 through 10; both delays accept 100 through 60,000 milliseconds, and the maximum
must not be below the base. Authentication, security-policy, capacity, rate-limit,
and cancellation failures remain terminal for this retry path. A server retry
never starts the security fallback.

## Authentication

Every authentication command accepts a provider name. The name is the exact key
under `agent.providers`, not the Pi adapter name:

```sh
cyberful auth login <name>
cyberful auth status <name>
cyberful auth logout <name>
```

Omitting `<name>` selects `main_provider`. With `auth.type: subscription`,
Cyberful automatically selects the provider-owned login: OpenAI Codex opens its
OAuth browser or device-code flow, while Z.AI Coding Plan and Kimi For Coding
prompt securely for the plan key. OAuth tokens and stored plan keys remain in
Cyberful's owner-only credential store.

`auth status` and the launch preflight resolve the credential into the actual
request authentication used by Pi; the mere presence of a stored OAuth record
is not considered available. The same provider registry and OAuth bootstrap run
inside the separately compiled TUI Worker that owns phase execution.

Environment-backed providers reference a variable name:

```yaml
auth:
  type: environment
  variable: ZAI_API_KEY
```

Set the value in the real process environment or the launch directory's `.env`.
Never put an API key, access token, refresh token, password, authorization
header, or credential-bearing URL in `settings.yaml`; Cyberful rejects inline
secrets before formatting validation errors.

## Main providers

Cyberful admits these reviewed Pi adapters as `main_provider`:

| Adapter              | Service                                 | Authentication                         |
| -------------------- | --------------------------------------- | -------------------------------------- |
| `openai-codex`       | OpenAI Codex through a ChatGPT plan     | `subscription`                         |
| `zai`                | Z.AI Coding Plan                        | `subscription` or `environment`        |
| `kimi-coding`        | Kimi For Coding, the Moonshot plan API  | `subscription` or `environment`        |
| `moonshotai`         | Moonshot AI usage-based API             | `environment`                          |
| `openai-completions` | Reviewed OpenAI-compatible custom route | `environment`                          |

Provider keys are operator-defined. This makes a Kimi subscription available
under the name `kimi`, for example. The snippets below show only the fields to
change inside the complete generated `settings.yaml`; keep the required
subagent, fallback, and instruction sections:

```yaml
agent:
  main_provider: kimi

  providers:
    kimi:
      adapter: kimi-coding
      model: k3
      auth:
        type: subscription
```

Authenticate the configured key, regardless of its adapter:

```sh
cyberful auth login kimi
cyberful auth status kimi
```

Z.AI uses the same contract:

```yaml
agent:
  main_provider: zai-plan

  providers:
    zai-plan:
      adapter: zai
      model: glm-5.2
      auth:
        type: subscription
```

```sh
cyberful auth login zai-plan
```

## OpenAI-compatible GLM fallback

GLM 5.2 uses Pi's OpenAI Chat Completions adapter. It does not require OpenAI
Responses compatibility. The configured limits below follow the
[official GLM 5.2 model guide](https://docs.z.ai/guides/llm/glm-5.2):

```yaml
version: 1

agent:
  subsystem: pi
  main_provider: openai-codex
  fallback_provider: glm-5-2

  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2

  compaction:
    enabled: true
    trigger_percentage: 68

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000

  fallback:
    proactive:
      enabled: true
      percentage: 2
    automatic_security_block:
      enabled: true

  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.6-sol
      auth:
        type: subscription

    glm-5-2:
      adapter: openai-completions
      base_url: https://api.z.ai/api/paas/v4
      model: glm-5.2
      auth:
        type: environment
        variable: ZAI_API_KEY
      context_window: 1000000
      max_output_tokens: 131072

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
```

Custom OpenAI-compatible providers require an absolute HTTP or HTTPS
`base_url`, `context_window`, `max_output_tokens`, and environment-based
authentication. Cyberful admits an adapter only when it preserves an authentic
system-message channel; endpoints that concatenate the Cyberful system contract
into user content are refused before a run begins.

## What fallback means

Fallback is enabled only when `fallback_provider` names a configured provider
different from the main provider. Only one fallback route may be active.

There are two admission paths:

- A main root or subagent may request one specific, bounded fallback task
  when it predicts an imminent provider security-policy block. Proactive
  admissions share the session quota configured by `percentage`; the default is
  2%.
- Cyberful may start fallback automatically after the main provider returns a
  provider-specific, structured `security_policy_block`. Automatic admissions
  do not consume the proactive quota.

Timeouts, rate limits, authentication failures, capacity errors, network
failures, malformed output, and generic text such as “unsafe” do not activate
the security fallback.

An admitted fallback is a complete Pi `AgentRun`, not a reduced completion. It
receives the same workflow authorization, persona, workarea, gateway tools,
skill catalog, evidence duties, and bounded ability to create subagents as the
requesting run. Its provider affinity is fixed to the fallback route, and every
descendant remains on that provider. There is no automatic fallback-to-main
ping-pong. A terminal failure on the fallback route returns any partial result
to the parent and ends that branch.

Only the original root of the phase may call `handoff`. Main-route children,
fallback roots, and fallback descendants can complete work and write permitted
artifacts, but return their structured result to their parent.

The proactive admission ceiling is shared by the session:

```text
floor(main actor runs × percentage / 100) + 1
```

Each admitted fallback root consumes one slot. Its descendants belong to that
same admission. All trees remain bounded by `max_per_run`, `max_concurrent`,
`max_depth`, the phase budget, the child budget, and worker capacity.
Cyberful persists the session counters in an owner-only host ledger, so a
restart or a later phase cannot reset the proactive quota. Removing the session
also removes its ledger.

## Trusted instructions and skills

Cyberful does not discover instructions, plugins, MCP servers, or skills from
`~/.pi`, `.codex`, `.agents`, `.claude`, or the target repository. First-party
personas and skills are embedded release policy. Additional roots are loaded
only when explicitly listed in `instructions.persona_roots` or
`instructions.skill_roots`.

Each run receives a compact catalog, then reads a selected `SKILL.md` in full
before using it. References, scripts, agents, and assets remain package-bound
and are loaded only as required. `allow_project_discovery` must remain `false`;
additional trusted content is admitted only through the two explicit root
lists.

`settings.yaml` is strict: unknown keys, unknown providers, duplicate routing,
an absent main provider, an enabled fallback without a fallback provider,
malformed URLs, and inline secrets are fatal startup errors.
