# Agent providers and fallback

Cyberful uses Pi Agent for every model-backed operation. `settings.yaml` selects
the inference providers used by Pi; it does not select a second agent runtime.
The file lives in the directory from which Cyberful is launched. If it is
missing, Cyberful creates an owner-only, secret-free default:

```yaml
version: 1

agent:
  subsystem: pi
  primary_provider: openai-codex

  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2

  fallback:
    proactive:
      enabled: false
      percentage: 2
    automatic_security_block:
      enabled: false

  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.4
      auth:
        type: oauth
        profile: default

instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
```

At least one provider and a valid `primary_provider` are required. Provider and
model selection is host-owned: an agent cannot add a route, choose its own
provider, or change the tool policy.

## Authentication

OpenAI Codex is a Pi provider authenticated through Cyberful, not an installed
CLI or a separate runtime:

```sh
cyberful auth login
cyberful auth status
cyberful auth logout
```

OAuth credentials are kept in Cyberful's owner-only credential store.
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

## OpenAI-compatible GLM fallback

GLM 5.2 uses Pi's OpenAI Chat Completions adapter. It does not require OpenAI
Responses compatibility. The configured limits below follow the
[official GLM 5.2 model guide](https://docs.z.ai/guides/llm/glm-5.2):

```yaml
version: 1

agent:
  subsystem: pi
  primary_provider: openai-codex
  fallback_provider: glm-5-2

  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2

  fallback:
    proactive:
      enabled: true
      percentage: 2
    automatic_security_block:
      enabled: true

  providers:
    openai-codex:
      adapter: openai-codex
      model: gpt-5.4
      auth:
        type: oauth
        profile: default

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
different from the primary. Only one fallback route may be active.

There are two admission paths:

- A primary root or subagent may request one specific, bounded fallback task
  when it predicts an imminent provider security-policy block. Proactive
  admissions share the session quota configured by `percentage`; the default is
  2%.
- Cyberful may start fallback automatically after the primary returns a
  provider-specific, structured `security_policy_block`. Automatic admissions
  do not consume the proactive quota.

Timeouts, rate limits, authentication failures, capacity errors, network
failures, malformed output, and generic text such as “unsafe” do not activate
the security fallback.

An admitted fallback is a complete Pi `AgentRun`, not a reduced completion. It
receives the same workflow authorization, persona, workarea, gateway tools,
skill catalog, evidence duties, and bounded ability to create subagents as the
requesting run. Its provider affinity is fixed to the fallback route, and every
descendant remains on that provider. There is no automatic fallback-to-primary
ping-pong. A terminal failure on the fallback route returns any partial result
to the parent and ends that branch.

Only the original root of the phase may call `handoff`. Primary children,
fallback roots, and fallback descendants can complete work and write permitted
artifacts, but return their structured result to their parent.

The proactive admission ceiling is shared by the session:

```text
floor(primary actor runs × percentage / 100) + 1
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
an absent primary, an enabled fallback without a fallback provider, malformed
URLs, and inline secrets are fatal startup errors.
