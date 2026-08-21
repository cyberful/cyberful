// ── Pi Provider Preflight Tests ──────────────────────────────────
// Verifies that every enabled provider route is authenticated before launch.
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

const MAIN = "main"
const FALLBACK = "fallback"

const settings = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: ${MAIN}
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
    ${MAIN}:
      adapter: openai-completions
      base_url: https://main.example/v1
      model: main-model
      auth:
        type: environment
        variable: MAIN_API_KEY
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
    id: provider === MAIN ? "main-model" : "fallback-model",
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

function registry(
  authentication: Readonly<Record<string, boolean>>,
  resolutionFailure?: Readonly<Record<string, Error>>,
): PiModels {
  const models = createModels()
  for (const providerID of [MAIN, FALLBACK]) {
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
            resolve: async () => {
              const failure = resolutionFailure?.[providerID]
              if (failure) throw failure
              return authenticated
                ? {
                    auth: { apiKey: `${providerID}-test-key` },
                    source: `${providerID.toUpperCase()}_API_KEY`,
                  }
                : undefined
            },
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
    contextCapacity(providerID) {
      const model = models.getModel(providerID, `${providerID}-model`)
      if (!model) throw new Error(`Missing test model for '${providerID}'`)
      return {
        catalogContextWindow: model.contextWindow,
        trustedRouteWindow: model.contextWindow,
        operationalContextWindow: Math.min(256_000, model.contextWindow),
        source: "catalog_default",
        warnings: [],
      }
    },
    adapter: () => "openai-completions",
    loginType: () => "api_key",
  }
}

describe("Pi provider preflight", () => {
  test("blocks launch when an enabled fallback route is not authenticated", async () => {
    const subsystem = new PiAgentSubsystem({
      settings,
      registry: registry({ [MAIN]: true, [FALLBACK]: false }),
    })
    try {
      const status = await subsystem.preflight(settings)

      expect(status.ready).toBe(false)
      expect(status.degraded).toBe(false)
      expect(status.providers).toEqual([
        {
          id: MAIN,
          model: "main-model",
          route: "main",
          authenticated: true,
          reasoningEffort: "ultra",
          effectiveReasoningEffort: "off",
          authSource: "MAIN_API_KEY",
          context: {
            catalogContextWindow: 100_000,
            trustedRouteWindow: 100_000,
            operationalContextWindow: 100_000,
            source: "catalog_default",
            warnings: [],
          },
        },
        {
          id: FALLBACK,
          model: "fallback-model",
          route: "fallback",
          authenticated: false,
          reasoningEffort: "ultra",
          effectiveReasoningEffort: "off",
          context: {
            catalogContextWindow: 100_000,
            trustedRouteWindow: 100_000,
            operationalContextWindow: 100_000,
            source: "catalog_default",
            warnings: [],
          },
        },
      ])
      expect(status.errors).toEqual(["Provider 'fallback' has no configured environment"])
    } finally {
      await subsystem.shutdown()
    }
  })

  test("keeps a missing main credential fatal even when fallback is authenticated", async () => {
    const subsystem = new PiAgentSubsystem({
      settings,
      registry: registry({ [MAIN]: false, [FALLBACK]: true }),
    })
    try {
      const status = await subsystem.preflight(settings)

      expect(status.ready).toBe(false)
      expect(status.degraded).toBe(false)
      expect(status.errors).toEqual(["Provider 'main' has no configured environment"])
    } finally {
      await subsystem.shutdown()
    }
  })

  test("rejects a main credential that exists but cannot derive request authentication", async () => {
    const subsystem = new PiAgentSubsystem({
      settings,
      registry: registry(
        { [MAIN]: true, [FALLBACK]: true },
        { [MAIN]: new Error("OAuth auth derivation failed for main") },
      ),
    })
    try {
      const status = await subsystem.preflight(settings)

      expect(status.ready).toBe(false)
      expect(status.degraded).toBe(false)
      expect(status.providers).toEqual([
        {
          id: FALLBACK,
          model: "fallback-model",
          route: "fallback",
          authenticated: true,
          reasoningEffort: "ultra",
          effectiveReasoningEffort: "off",
          authSource: "FALLBACK_API_KEY",
          context: {
            catalogContextWindow: 100_000,
            trustedRouteWindow: 100_000,
            operationalContextWindow: 100_000,
            source: "catalog_default",
            warnings: [],
          },
        },
      ])
      expect(status.errors).toEqual([
        "API key auth failed for provider main: OAuth auth derivation failed for main",
      ])
    } finally {
      await subsystem.shutdown()
    }
  })
})
