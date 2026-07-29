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
    })
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
    expect(registry.adapter("zai-plan")).toBe("zai")
    expect(registry.loginType("zai-plan")).toBe("api_key")
    expect(registry.model("zai-plan")).toMatchObject({
      provider: "zai-plan",
      id: "glm-5.2",
      api: "openai-completions",
    })
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
