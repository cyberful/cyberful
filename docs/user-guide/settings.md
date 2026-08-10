# Agent providers and fallback

Cyberful uses Pi Agent for every model-backed operation. `settings.yaml` selects the inference providers used by Pi; it does not select a second agent runtime. The file lives in the directory from which Cyberful is launched. If it is missing, Cyberful creates an owner-only, secret-free default:

```yaml
version: 1

agent:
  subsystem: pi
  main_provider: openai-codex
  reasoning_effort: ultra

  subagents:
    enabled: true
    provider: openai-codex
    reasoning_effort: [xhigh, medium]
    max_per_run: 5
    max_concurrent: 5
    max_depth: 2
    timeout_minutes: 30

  compaction:
    enabled: true
    trigger_percentage: 75
    target_percentage: 35
    model_summary: true
    summarizer:
      provider: inherit
      reasoning_effort: medium

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000
    attempt_timeout_ms: 600000
    max_phase_extension_minutes: 15

  phase_recovery:
    enabled: true
    max_restarts: 1
    use_fallback_provider: true

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
      operational_context_window: 256000
      auth:
        type: subscription

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
```

At least one provider and a valid `main_provider` are required. Provider and model selection is host-owned: an agent cannot add a route, choose its own provider, or change the tool policy.

## Reasoning effort

`agent.reasoning_effort` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` and defaults to `ultra`. On load, Cyberful inserts the explicit default into an existing `settings.yaml` that omitted it, preserving the rest of the document. Root, top-level fallback, and phase-recovery root AgentRuns use this request. Delegated AgentRuns use the independent `agent.subagents.reasoning_effort` profile described below.

`ultra` is a portable Cyberful profile meaning “use the strongest reasoning level this route supports”; it is not forwarded as a provider wire value. GPT-5.6 Sol through the `openai-codex` adapter currently resolves it to `reasoning.effort: max`, matching Codex's separation between its local Ultra profile and provider reasoning. Codex associates that local profile with automatic task delegation; Cyberful instead retains its own phase-scoped, bounded subagent orchestration. Other models use Pi's supported-level clamping. `run_started`, terminal run metadata, and `raw/operations/run-state.json` record both `reasoning_effort` (requested) and `effective_reasoning_effort`, so a fallback downgrade remains visible.

## Subagent route, reasoning, and identity

`agent.subagents.provider` names an existing route and `agent.subagents.reasoning_effort` is the unordered allowlist of child reasoning profiles. `xhigh` is mandatory and is the default when `delegate_task` omits its optional `reasoning_effort`; the direct parent may select another allowed level for each delegation, including nested ones. The tool recommends selecting `medium` explicitly for bounded evidence collection; omission keeps `xhigh` for exploration, synthesis, and complex exploit chains. Duplicate or unsupported allowlist entries are rejected, and a disallowed request fails before it consumes quota or starts a child. The generated default is `[xhigh, medium]`. Version 1 scalar settings migrate in place: `xhigh` becomes `[xhigh]`, `high` becomes `[high, xhigh]`, and `medium` becomes `[medium, xhigh]`. Older settings use an available `openai-codex` route; if none exists they inherit `main_provider` with a runtime warning. An unavailable configured route fails explicitly.

Fallback-affine descendants remain on the fallback provider but keep the parent-selected child reasoning request. Each child records `selection_source: parent | default`, requested effort, and the effective level after provider clamping. Scope, persona, tools, traffic policy, workarea, and the single phase budget remain inherited from the parent.

Before spawn, the host validates or deterministically generates an immutable short slug and one emoji. The TUI renders identities as `@{👾 api-monster}`. Terminal controls, bidi content, malformed emoji, and collisions cannot become display identities; AgentRun IDs remain the authoritative ownership keys.

## AgentRun context rotation

`agent.compaction` protects every root, delegated, and fallback `AgentRun` from exhausting its provider context during a long phase. Existing version 1 settings that omit the new fields receive the defaults shown above.

Cyberful distinguishes three limits:

- `context_window` is the trusted route/catalog capacity. For a built-in Pi model it may restrict the catalog but cannot enlarge it. A larger value is ignored with a warning. A custom `openai-completions` route must declare this hard limit.
- `operational_context_window` is Cyberful's working input limit. When omitted, it is `min(context_window, 256000)`. An explicit value is clamped to the trusted route limit with a warning.
- `observed_context_upper_bound` is learned for the session and route after an actual `context_length_exceeded`. It becomes the lower effective limit for root, child, and fallback-affine runs on that route.

Catalog data is local and versioned with Pi/Cyberful. Runtime never fetches model limits from the web.

`trigger_percentage` accepts 50 through 85 and defaults to 75. `target_percentage` is positive, must be lower than the trigger, and defaults to 35. At the default 256K operational window, rotation starts at exactly 192,000 estimated input tokens and targets at most 89,600. The estimate includes the immutable system prompt, loaded tool schemas, messages, and projected tool results; it does not count generated reasoning.

The operational window and percentages are the soft compaction policy. The hard input limit is separate: Cyberful subtracts a fixed continuation reserve of at most 16,384 tokens, capped by the model's maximum output, from the trusted route window. This preserves room for the next response without lowering the normal 256K soft window.

At a safe boundary between provider responses, Cyberful first archives selected historical ZAP, browser, cyberful-os, and host-tool results under `raw/context-tool-results/`. A deterministic archival `noop` is not a failed rotation. The tool result's bounded active representation keeps its call ID, state, excerpt, path, and SHA-256; the append-only transcript retains the complete original result.

The configured tool-free summarizer then creates one validated JSON checkpoint, bounded to 8,192 output tokens. It records objective, phase, current state, decisions and reasons, verified facts, hypothesis/finding/test references, completed and open activity, blockers, errors, failed attempts, `mistakes_not_to_repeat`, next actions, `working_notes`, and `what_i_would_do_next`. References must occur in the supplied source and all strings pass credential redaction. The versioned JSON artifact under `raw/context-summaries/` records its generation, source counts, source estimate, summarizer route/model/effort, evidence references, and SHA-256.

After validation and persistence, Cyberful constructs replacement memory from the host-owned checkpoint plus the newest complete message suffix that fits the remaining target budget. It walks backward and starts only at a user or assistant boundary; a tool result is retained only with its assistant tool call. Therefore a long autonomous turn can be compacted in the middle: its settled prefix lives in the checkpoint and only its bounded recent suffix is re-injected. Older checkpoint messages do not accumulate. The host verifies pairing and size, then assigns `agent.state.messages` once. The original session transcript and durable workarea evidence remain complete.

If replacement memory is above 35% but below the hard input limit, Cyberful installs it and emits `target_unreachable`; remaining above the soft trigger is not terminal. `active_tail_too_large` occurs only when checkpoint plus fixed context cannot fit under the hard limit. Cyberful then restarts the phase once on the same route with a reconciliation instruction that lists and preserves all hypotheses.

`summarizer.provider: inherit` uses the AgentRun route. A configured provider name selects an already declared route. Summarizer effort defaults to `medium` and is independent of the run's reasoning profile. There are at most three tool-free attempts: the configured route, the same route with a 50% smaller source only after a context rejection, then the active route once when it is different. The security fallback is never used.

A failed summarizer generation no longer restores oversized history. Cyberful immediately persists and installs an owner-only deterministic checkpoint containing only host-observed task, evidence, artifact, registry, completed-call, last-public-output, and bounded recent-queue state; it contains no model inference. Diagnostic events retain every summarizer attempt and the complete bounded cause. Setting legacy `model_summary: false` uses this deterministic path without invoking a summarizer.

On `context_length_exceeded`, Cyberful records `min(current_limit, floor(failed_input × 0.80))`, removes only the failed assistant message, rotates in emergency mode, and retries generation once. A second context rejection terminates as `context_rotation_failed`; completed tools are not executed again and generic provider retry is not entered. A delegated run may then start exactly one fresh child linked by `recovery_of`, using the same task, output artifact, requested reasoning, remaining budget, and deterministic checkpoint. The restart is exempt from a new `max_per_run` charge but still obeys concurrency, depth, closeout, and budget limits. If the residual budget is insufficient, the parent receives the typed failure and checkpoint instead. Root recovery remains governed by `agent.phase_recovery`.

New transcripts use `context_rotation` events with `started`/`completed`/`partial`/`failed`, generation, route/model/effort, every resolved limit and its source, source/active/summarized message counts, split-turn status, before/after estimates, checkpoint attestation, and per-attempt token usage. Readers continue to accept historical `context_compaction` events. `run_started`, terminal run metadata, `raw/operations/run-state.json`, and the phase runtime manifest expose catalog, configured, operational, observed, and effective limits.

## Transient provider retry

`agent.retry` controls a global, same-turn retry for provider failures classified as `unavailable`, including `server_error` and transient service-saturation signals such as `server_is_overloaded`. An abnormal Codex WebSocket closure (`1006`) uses the same recovery path. Existing version 1 settings that omit the section receive the defaults shown above; no migration is required.

The runtime preserves the user message, successful assistant tool calls, and their tool results, removes only the failed assistant message, and continues the same `AgentRun`. Completed tools are therefore not executed again. Every attempt still contributes to usage totals, while partial text from a discarded attempt is not published.

Backoff is exponential with full jitter, bounded by `max_delay_ms`, and is interrupted by cancellation or shutdown. The phase's active-execution clock is suspended for the complete retry cycle—from scheduling through backoff and the provider response—so provider downtime does not consume research or closeout time. Suspension ends as soon as the retry response is received, before any tool call in that response executes; tool execution therefore spends normal active phase time. Concurrent retries and approvals count as one union interval. `max_retries` accepts 1 through 10; both delays accept 100 through 60,000 milliseconds. `attempt_timeout_ms` accepts 1,000 through 600,000 milliseconds, defaults to ten minutes, and aborts only the current retry attempt. Total retry compensation is one phase-wide pool configured by `max_phase_extension_minutes`, which defaults to 15. Root, children, retries, fallback, and phase recovery share it; overlapping waits consume their temporal union. Exhausting it never resets or moves the deadline again. A server retry never starts the security fallback. Runtime artifacts distinguish the complete `retry_wait_ms` from capped `retry_compensation_ms`, so provider downtime remains visible after the phase can no longer extend its deadline.

## Phase provider recovery

`agent.phase_recovery` starts one fresh phase owner after same-turn retry is exhausted and the provider failure remains explicitly retryable. A structured main-provider `security_policy_block` is also recoverable when `use_fallback_provider` is true and an authenticated fallback route is configured. The replacement receives only the remaining phase budget and reads the existing workarea, semantic checkpoint, registries, tool-usage evidence, and prior-attempt transcript so it can continue without deliberately repeating completed effects. The replacement root and every descendant retain fallback affinity and never return automatically to main; a policy block on that fallback route is terminal. Authentication, cancellation, invalid handoffs, missing artifacts, and unverified cleanup never use this path.

After ordinary retry and context-recovery options are exhausted, one failed main-route subagent may be replaced once on the authenticated fallback route with the same task, output artifact, checkpoint, and residual child budget. The replacement and descendants remain fallback-affine. This automatic recovery is separate from proactive admission and does not consume its quota.

## Authentication

Every authentication command accepts a provider name. The name is the exact key under `agent.providers`, not the Pi adapter name:

```sh
cyberful auth login <name>
cyberful auth status <name>
cyberful auth logout <name>
```

Omitting `<name>` selects `main_provider`. With `auth.type: subscription`, Cyberful automatically selects the provider-owned login: OpenAI Codex opens its OAuth browser or device-code flow, while Z.AI Coding Plan and Kimi For Coding prompt securely for the plan key. OAuth tokens and stored plan keys remain in Cyberful's owner-only credential store.

`auth status` and the launch preflight resolve the credential into the actual request authentication used by Pi; the mere presence of a stored OAuth record is not considered available. Whenever proactive fallback, automatic security fallback, fallback phase recovery, or failed-subagent replacement can route work to the fallback provider, preflight requires that route to authenticate before the phase starts. A missing credential names the configured provider and the exact recovery command, such as `cyberful auth login kimi`. The same provider registry and OAuth bootstrap run inside the separately compiled TUI Worker that owns phase execution.

Environment-backed providers reference a variable name:

```yaml
auth:
  type: environment
  variable: ZAI_API_KEY
```

Set the value in the real process environment or the launch directory's `.env`. Never put an API key, access token, refresh token, password, authorization header, or credential-bearing URL in `settings.yaml`; Cyberful rejects inline secrets before formatting validation errors.

## Main providers

Cyberful admits these reviewed Pi adapters as `main_provider`:

| Adapter              | Service                                 | Authentication                         |
| -------------------- | --------------------------------------- | -------------------------------------- |
| `openai-codex`       | OpenAI Codex through a ChatGPT plan     | `subscription`                         |
| `zai`                | Z.AI Coding Plan                        | `subscription` or `environment`        |
| `kimi-coding`        | Kimi For Coding, the Moonshot plan API  | `subscription` or `environment`        |
| `moonshotai`         | Moonshot AI usage-based API             | `environment`                          |
| `openai-completions` | Reviewed OpenAI-compatible custom route | `environment`                          |

Provider keys are operator-defined. This makes a Kimi subscription available under the name `kimi`, for example. The snippets below show only the fields to change inside the complete generated `settings.yaml`; keep the required subagent, fallback, and instruction sections:

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

GLM 5.2 uses Pi's OpenAI Chat Completions adapter. It does not require OpenAI Responses compatibility. The configured limits below follow the [official GLM 5.2 model guide](https://docs.z.ai/guides/llm/glm-5.2):

```yaml
version: 1

agent:
  subsystem: pi
  main_provider: openai-codex
  reasoning_effort: ultra
  fallback_provider: glm-5-2

  subagents:
    enabled: true
    provider: openai-codex
    reasoning_effort: [xhigh, medium]
    max_per_run: 5
    max_concurrent: 5
    max_depth: 2
    timeout_minutes: 30

  compaction:
    enabled: true
    trigger_percentage: 75
    target_percentage: 35
    model_summary: true
    summarizer:
      provider: inherit
      reasoning_effort: medium

  retry:
    enabled: true
    max_retries: 3
    base_delay_ms: 1000
    max_delay_ms: 15000
    attempt_timeout_ms: 600000
    max_phase_extension_minutes: 15

  phase_recovery:
    enabled: true
    max_restarts: 1
    use_fallback_provider: true

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
      operational_context_window: 256000
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

For a built-in adapter, explicit `context_window` and `max_output_tokens` values may only restrict Pi's bundled catalog metadata. They cannot enlarge it. The generated GPT-5.6 Sol route uses a 256,000-token operational window while the current Pi route catalog remains the hard authority. GLM-5.2, Kimi K3, and Moonshot Kimi K3 also default to 256K operationally; models whose catalog limit is smaller use that smaller value.

Custom OpenAI-compatible providers require an absolute HTTP or HTTPS `base_url`, `context_window`, `max_output_tokens`, and environment-based authentication. Cyberful admits an adapter only when it preserves an authentic system-message channel; endpoints that concatenate the Cyberful system contract into user content are refused before a run begins.

## What fallback means

Fallback is enabled only when `fallback_provider` names a configured provider different from the main provider. Only one fallback route may be active.

There are two admission paths:

- A main root or subagent may request one specific, bounded fallback task when it predicts an imminent provider security-policy block. Proactive admissions share the deterministic session quota configured by `percentage`; at the default this is explicitly “2% + 1”, not a random 2% probability.
- Cyberful may restart the same root phase or replace one exhausted main-route subagent after a provider-specific, structured `security_policy_block` or eligible terminal failure. Automatic security fallback and recovery admissions do not consume the proactive quota.

On the `openai-codex` adapter, the exact structured provider codes `cyberPolicy` and `cyber_policy` both normalize to `security_policy_block` with canonical code `cyberPolicy`. Message text never activates this classification, and `cyber_policy` from every other adapter remains `unknown`. The runtime diagnostic therefore records `profile: "security_policy_block"` and `code: "cyberPolicy"` before the configured fallback is considered.

Timeouts, rate limits, authentication failures, capacity errors, network failures, malformed output, and generic text such as “unsafe” do not activate the security fallback. Failures classified as retryable (`timeout`, `rate_limit`, `network`, and `unavailable`) use the bounded same-run retry policy. OpenAI Codex error code `23` is normalized as a retryable timeout.

An admitted fallback is a complete Pi `AgentRun`, not a reduced completion. It receives the same workflow authorization, persona, workarea, gateway tools, skill catalog, evidence duties, and bounded ability to create subagents as the requesting run. Its provider affinity is fixed to the fallback route, and every descendant remains on that provider. There is no automatic fallback-to-main ping-pong. A terminal failure on the fallback route returns any partial result to the parent and ends that branch.

Only the original root of the phase may call `handoff`. Main-route children, fallback roots, and fallback descendants can complete work and write permitted artifacts, but return their structured result to their parent.

The proactive admission ceiling is shared by the session:

```text
floor(main actor runs × percentage / 100) + 1
```

Each admitted fallback root consumes one slot. Its descendants belong to that same admission. All trees remain bounded by `max_per_run`, `max_concurrent`, `max_depth`, the phase budget, the child budget, and worker capacity. Cyberful persists the session counters in an owner-only host ledger, so a restart or a later phase cannot reset the proactive quota. Removing the session also removes its ledger.

The denominator counts main roots and main subagents across the session; fallback-affine trees never increase it. A failed proactive launch rolls its reserved admission back, while a completed launch or a launch that reached the provider consumes it. Automatic security fallback, phase recovery, and failed-subagent replacement are quota-exempt. The extra slot at every exact boundary is intentional: 49 and 50 main actors both admit 2 proactive roots at 2%, while 99 and 100 admit 2 and 3 respectively.

## Trusted instructions and skills

Cyberful does not discover instructions, plugins, MCP servers, or skills from `~/.pi`, `.codex`, `.agents`, `.claude`, or the target repository. First-party personas and skills are embedded release policy. Additional roots are loaded only when explicitly listed in `instructions.persona_roots` or `instructions.skill_roots`.

Each run receives a compact catalog, then reads a selected `SKILL.md` in full before using it. References, scripts, agents, and assets remain package-bound and are loaded only as required. `allow_project_discovery` must remain `false`; additional trusted content is admitted only through the two explicit root lists.

`settings.yaml` is strict: unknown keys, unknown providers, duplicate routing, an absent main provider, an enabled fallback without a fallback provider, malformed URLs, and inline secrets are fatal startup errors.
