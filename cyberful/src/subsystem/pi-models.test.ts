// ── Pi Provider Registry Tests ───────────────────────────────────
// Captures the resolved OpenAI Codex and OpenAI-compatible GLM model contracts
// without contacting either provider or accepting an unreviewed system channel.
// → cyberful/src/subsystem/pi-models.ts — owns provider materialization.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai"
import { Settings } from "@/config/settings"
import { assertAuthenticSystemChannel, createPiModels } from "./pi-models"

const GLM_SETTINGS = Settings.parse(`version: 1
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
`)

describe("Pi provider registry", () => {
  test("resolves the pinned OpenAI Codex OAuth catalog model through Pi", () => {
    const registry = createPiModels(GLM_SETTINGS.agent, new InMemoryCredentialStore())
    const model = registry.model("openai-codex")

    expect(registry.adapter("openai-codex")).toBe("openai-codex")
    expect(model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
    })
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
