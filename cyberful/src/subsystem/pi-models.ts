// ── Pi Provider And Model Registry ───────────────────────────────
// Materializes only providers declared in settings.yaml, preserving provider
// auth semantics and a real system-message channel for every AgentRun.
// ─────────────────────────────────────────────────────────────────

import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"

export interface ProviderSettings {
  readonly adapter: string
  readonly model: string
  readonly base_url?: string
  readonly context_window?: number
  readonly max_output_tokens?: number
  readonly auth:
    | { readonly type: "oauth"; readonly profile: string }
    | { readonly type: "environment"; readonly variable: string }
}

export interface AgentProviderSettings {
  readonly primary_provider: string
  readonly fallback_provider?: string
  readonly providers: Readonly<Record<string, ProviderSettings>>
}

function customOpenAIProvider(id: string, settings: ProviderSettings): Provider<"openai-completions"> {
  if (settings.auth.type !== "environment")
    throw new Error(`Custom OpenAI-compatible provider '${id}' requires environment authentication`)
  const baseUrl = settings.base_url?.trim()
  if (!baseUrl) throw new Error(`Custom OpenAI-compatible provider '${id}' requires base_url`)
  const contextWindow = settings.context_window
  const maxTokens = settings.max_output_tokens
  if (!contextWindow || !maxTokens)
    throw new Error(`Custom OpenAI-compatible provider '${id}' requires context_window and max_output_tokens`)

  const model: Model<"openai-completions"> = {
    id: settings.model,
    name: settings.model,
    api: "openai-completions",
    provider: id,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      thinkingFormat: /(?:^|\.)z\.ai$/i.test(new URL(baseUrl).hostname) ? "zai" : "openai",
      zaiToolStream: /(?:^|\.)z\.ai$/i.test(new URL(baseUrl).hostname),
    },
  }
  return createProvider({
    id,
    name: id,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${id} API key`, [settings.auth.variable]) },
    models: [model],
    api: openAICompletionsApi(),
  })
}

function declaredProvider(id: string, settings: ProviderSettings): Provider {
  if (settings.adapter === "openai-completions") return customOpenAIProvider(id, settings)
  if (id !== settings.adapter)
    throw new Error(`Built-in provider '${id}' must use the same settings id as adapter '${settings.adapter}'`)
  const provider = builtinProviders().find((candidate) => candidate.id === settings.adapter)
  if (!provider) throw new Error(`Unknown Pi provider adapter '${settings.adapter}'`)
  if (!provider.getModels().some((model) => model.id === settings.model))
    throw new Error(`Model '${settings.model}' is not present in Pi provider '${id}'`)
  if (settings.auth.type === "oauth" && !provider.auth.oauth)
    throw new Error(`Pi provider '${id}' does not support OAuth authentication`)
  if (settings.auth.type === "environment" && !provider.auth.apiKey)
    throw new Error(`Pi provider '${id}' does not support environment API-key authentication`)
  return provider
}

export interface PiModels {
  readonly models: Models
  model(providerID: string): Model<Api>
  adapter(providerID: string): string
}

// Pi core supplies no default prompt. Cyberful admits only reviewed adapters
// with a dedicated system/instructions channel; new provider extensions must
// be reviewed before joining this allowlist.
export function assertAuthenticSystemChannel(adapter: string, model: Model<Api>): void {
  const valid =
    (adapter === "openai-codex" && model.api === "openai-codex-responses") ||
    (adapter === "openai-completions" && model.api === "openai-completions") ||
    (adapter === "zai" && model.api === "openai-completions")
  if (!valid)
    throw new Error(
      `Pi adapter '${adapter}' with API '${model.api}' is not approved to preserve Cyberful's system message`,
    )
}

export function createPiModels(settings: AgentProviderSettings, credentials: CredentialStore): PiModels {
  const models: MutableModels = createModels({ credentials })
  models.clearProviders()
  for (const [id, providerSettings] of Object.entries(settings.providers))
    models.setProvider(declaredProvider(id, providerSettings))

  return {
    models,
    model(providerID) {
      const configured = settings.providers[providerID]
      if (!configured) throw new Error(`Provider '${providerID}' is not configured`)
      const model = models.getModel(providerID, configured.model)
      if (!model) throw new Error(`Model '${configured.model}' is not available from provider '${providerID}'`)
      assertAuthenticSystemChannel(configured.adapter, model)
      return model
    },
    adapter(providerID) {
      const configured = settings.providers[providerID]
      if (!configured) throw new Error(`Provider '${providerID}' is not configured`)
      return configured.adapter
    },
  }
}

export * as SubsystemPiModels from "./pi-models"
