// ── Pi Provider Registry Tests ───────────────────────────────────
// Captures configured provider aliases, subscription login selection, and the
// reviewed system-message channels without contacting any provider.
// → cyberful/src/subsystem/pi-models.ts — owns provider materialization.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai"
import { Settings } from "@/config/settings"
import { assertAuthenticSystemChannel, createPiModels } from "./pi-models"

const GLM_SETTINGS = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: flagship
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
    flagship:
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
`)

const SUBSCRIPTION_SETTINGS = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: kimi
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
    kimi:
      adapter: kimi-coding
      model: k3
      auth:
        type: subscription
    zai-plan:
      adapter: zai
      model: glm-5.2
      auth:
        type: subscription
    moonshot:
      adapter: moonshotai
      model: kimi-k3
      auth:
        type: environment
        variable: MOONSHOT_API_KEY
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

describe("Pi provider registry", () => {
  test("resolves an aliased OpenAI Codex subscription model through Pi", () => {
    const registry = createPiModels(GLM_SETTINGS.agent, new InMemoryCredentialStore())
    const model = registry.model("flagship")

    expect(registry.adapter("flagship")).toBe("openai-codex")
    expect(registry.loginType("flagship")).toBe("oauth")
    expect(model).toMatchObject({
      provider: "flagship",
      id: "gpt-5.6-sol",
      api: "openai-codex-responses",
      contextWindow: 272_000,
      maxTokens: 128_000,
    })
    expect(registry.contextCapacity("flagship")).toMatchObject({
      catalogContextWindow: 272_000,
      trustedRouteWindow: 272_000,
      operationalContextWindow: 256_000,
      source: "catalog_default",
      warnings: [],
    })
  })

  test("allows builtin limits to restrict but never enlarge the catalog", () => {
    const configured = Settings.parse(
      Settings.DEFAULT_YAML
        .replace(
          "      operational_context_window: 256000",
          [
            "      context_window: 900000",
            "      operational_context_window: 300000",
            "      max_output_tokens: 64000",
          ].join("\n"),
        ),
    )
    const registry = createPiModels(configured.agent, new InMemoryCredentialStore())

    expect(registry.model("openai-codex")).toMatchObject({
      contextWindow: 272_000,
      maxTokens: 64_000,
    })
    expect(registry.contextCapacity("openai-codex")).toMatchObject({
      catalogContextWindow: 272_000,
      configuredContextWindow: 900_000,
      trustedRouteWindow: 272_000,
      configuredOperationalContextWindow: 300_000,
      operationalContextWindow: 272_000,
      source: "configured_operational_clamped",
    })
    expect(registry.contextCapacity("openai-codex").warnings).toHaveLength(2)
  })

  test("uses settings keys for Kimi and Z.AI subscription credentials", () => {
    const registry = createPiModels(SUBSCRIPTION_SETTINGS.agent, new InMemoryCredentialStore())

    expect(registry.adapter("kimi")).toBe("kimi-coding")
    expect(registry.loginType("kimi")).toBe("api_key")
    expect(registry.model("kimi")).toMatchObject({
      provider: "kimi",
      id: "k3",
      api: "anthropic-messages",
    })
    expect(registry.contextCapacity("kimi").operationalContextWindow).toBe(256_000)
    expect(registry.adapter("zai-plan")).toBe("zai")
    expect(registry.loginType("zai-plan")).toBe("api_key")
    expect(registry.model("zai-plan")).toMatchObject({
      provider: "zai-plan",
      id: "glm-5.2",
      api: "openai-completions",
    })
    expect(registry.contextCapacity("zai-plan").operationalContextWindow).toBe(256_000)
    expect(registry.contextCapacity("moonshot").operationalContextWindow).toBe(256_000)
  })

  test("persists subscription login under the configured settings key", async () => {
    const credentials = new InMemoryCredentialStore()
    const registry = createPiModels(SUBSCRIPTION_SETTINGS.agent, credentials)

    await registry.models.login("kimi", registry.loginType("kimi"), {
      prompt: async () => "subscription-secret",
      notify: () => {},
    })

    expect(await credentials.read("kimi")).toEqual({
      type: "api_key",
      key: "subscription-secret",
    })
    expect(await credentials.read("kimi-coding")).toBeUndefined()
  })

  test("does not resolve ambient keys for a subscription-auth provider", async () => {
    const registry = createPiModels(SUBSCRIPTION_SETTINGS.agent, new InMemoryCredentialStore())
    const auth = registry.models.getProvider("kimi")?.auth.apiKey

    expect(
      await auth?.resolve({
        ctx: {
          env: async () => "ambient-key-must-not-activate-subscription",
          fileExists: async () => false,
        },
      }),
    ).toBeUndefined()
  })

  test("materializes GLM 5.2 as OpenAI Chat Completions with a real system role", () => {
    const registry = createPiModels(GLM_SETTINGS.agent, new InMemoryCredentialStore())
    const model = registry.model("glm-5-2")

    expect(registry.adapter("glm-5-2")).toBe("openai-completions")
    expect(model).toMatchObject({
      provider: "glm-5-2",
      id: "glm-5.2",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    })
  })

  test("uses a smaller custom route limit instead of the 256K default", () => {
    const configured = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: small
  subagents:
    enabled: true
    max_per_run: 1
    max_concurrent: 1
    max_depth: 1
  fallback:
    proactive:
      enabled: false
      percentage: 2
    automatic_security_block:
      enabled: false
  providers:
    small:
      adapter: openai-completions
      base_url: https://small.invalid/v1
      model: small-model
      context_window: 100000
      max_output_tokens: 8192
      auth:
        type: environment
        variable: SMALL_API_KEY
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)
    const registry = createPiModels(configured.agent, new InMemoryCredentialStore())

    expect(registry.contextCapacity("small")).toMatchObject({
      catalogContextWindow: 100_000,
      trustedRouteWindow: 100_000,
      operationalContextWindow: 100_000,
      source: "catalog_default",
    })
  })

  test("rejects an adapter that has no reviewed provider-level system channel", () => {
    const model = {
      id: "unreviewed-model",
      name: "Unreviewed",
      api: "pi-messages",
      provider: "unreviewed",
      baseUrl: "https://provider.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_192,
    } satisfies Model<"pi-messages">

    expect(() => assertAuthenticSystemChannel("unreviewed", model)).toThrow(
      "not approved to preserve Cyberful's system message",
    )
  })
})
