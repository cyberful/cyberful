// ── Pi Provider Preflight Tests ──────────────────────────────────
// Verifies that primary authentication controls launch readiness while an
//   unavailable optional fallback is reported as non-blocking degradation.
// → cyberful/src/subsystem/pi-agent.ts — owns provider readiness inspection.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  createModels,
  createProvider,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai"
import { Settings } from "@/config/settings"
import { PiAgentSubsystem } from "./pi-agent"
import type { PiModels } from "./pi-models"

const PRIMARY = "primary"
const FALLBACK = "fallback"

const settings = Settings.parse(`version: 1
agent:
  subsystem: pi
  primary_provider: ${PRIMARY}
  fallback_provider: ${FALLBACK}
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
    ${PRIMARY}:
      adapter: openai-completions
      base_url: https://primary.example/v1
      model: primary-model
      auth:
        type: environment
        variable: PRIMARY_API_KEY
      context_window: 100000
      max_output_tokens: 10000
    ${FALLBACK}:
      adapter: openai-completions
      base_url: https://fallback.example/v1
      model: fallback-model
      auth:
        type: environment
        variable: FALLBACK_API_KEY
      context_window: 100000
      max_output_tokens: 10000
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

const unusedStreams: ProviderStreams = {
  stream() {
    throw new Error("Provider streaming is outside preflight")
  },
  streamSimple() {
    throw new Error("Provider streaming is outside preflight")
  },
}

function configuredModel(provider: string): Model<"openai-completions"> {
  return {
    id: provider === PRIMARY ? "primary-model" : "fallback-model",
    name: provider,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.example/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  }
}

function registry(authentication: Readonly<Record<string, boolean>>): PiModels {
  const models = createModels()
  for (const providerID of [PRIMARY, FALLBACK]) {
    const authenticated = authentication[providerID] ?? false
    models.setProvider(
      createProvider({
        id: providerID,
        auth: {
          apiKey: {
            name: `${providerID} test authentication`,
            check: async () =>
              authenticated
                ? { type: "api_key" as const, source: `${providerID.toUpperCase()}_API_KEY` }
                : undefined,
            resolve: async () => undefined,
          },
        },
        models: [configuredModel(providerID)],
        api: unusedStreams,
      }),
    )
  }

  return {
    models,
    model(providerID) {
      const model = models.getModel(providerID, `${providerID}-model`)
      if (!model) throw new Error(`Missing test model for '${providerID}'`)
      return model
    },
    adapter: () => "openai-completions",
  }
}

describe("Pi provider preflight", () => {
  test("keeps primary-backed sessions ready when only fallback authentication is missing", async () => {
    const subsystem = new PiAgentSubsystem({
      settings,
      registry: registry({ [PRIMARY]: true, [FALLBACK]: false }),
    })
    try {
      const status = await subsystem.preflight(settings)

      expect(status.ready).toBe(true)
      expect(status.degraded).toBe(true)
      expect(status.providers).toEqual([
        {
          id: PRIMARY,
          model: "primary-model",
          route: "primary",
          authenticated: true,
          authSource: "PRIMARY_API_KEY",
        },
        {
          id: FALLBACK,
          model: "fallback-model",
          route: "fallback",
          authenticated: false,
        },
      ])
      expect(status.errors).toEqual(["Provider 'fallback' has no configured environment"])
    } finally {
      await subsystem.shutdown()
    }
  })

  test("keeps a missing primary credential fatal even when fallback is authenticated", async () => {
    const subsystem = new PiAgentSubsystem({
      settings,
      registry: registry({ [PRIMARY]: false, [FALLBACK]: true }),
    })
    try {
      const status = await subsystem.preflight(settings)

      expect(status.ready).toBe(false)
      expect(status.degraded).toBe(false)
      expect(status.errors).toEqual(["Provider 'primary' has no configured environment"])
    } finally {
      await subsystem.shutdown()
    }
  })
})
