// ── Pi Provider And Model Registry ───────────────────────────────
// Materializes only providers declared in settings.yaml, preserving provider
// auth semantics, trusted catalog limits, and a bounded operational window.
// → cyberful/src/config/settings.ts — supplies route-local working-context limits.
// @docs/user-guide/settings.md
// ─────────────────────────────────────────────────────────────────

import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type ApiKeyAuth,
  type AuthType,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
  type ProviderAuth,
} from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import "@/bootstrap-pi-oauth"

export interface ProviderSettings {
  readonly adapter: string
  readonly model: string
  readonly base_url?: string
  readonly context_window?: number
  readonly operational_context_window?: number
  readonly max_output_tokens?: number
  readonly auth:
    | { readonly type: "subscription" }
    | { readonly type: "environment"; readonly variable: string }
}

export interface AgentProviderSettings {
  readonly main_provider: string
  readonly fallback_provider?: string
  readonly providers: Readonly<Record<string, ProviderSettings>>
}

const MAIN_ADAPTERS = new Set(["openai-codex", "zai", "kimi-coding", "moonshotai", "openai-completions"])
const SUBSCRIPTION_ADAPTERS = new Set(["openai-codex", "zai", "kimi-coding"])
export const DEFAULT_OPERATIONAL_CONTEXT_WINDOW = 256_000

export interface ModelContextCapacity {
  readonly catalogContextWindow: number
  readonly configuredContextWindow?: number
  readonly trustedRouteWindow: number
  readonly configuredOperationalContextWindow?: number
  readonly operationalContextWindow: number
  readonly source:
    | "catalog_default"
    | "catalog_restricted"
    | "configured_operational"
    | "configured_operational_clamped"
  readonly warnings: readonly string[]
}

function storedApiKeyAuth(auth: ApiKeyAuth): ApiKeyAuth {
  const login = auth.login
  if (!login) throw new Error(`${auth.name} does not expose an interactive login`)
  return {
    name: auth.name,
    login,
    check: async ({ credential }) =>
      credential?.key ? { type: "api_key", source: "stored credential" } : undefined,
    resolve: async ({ credential }) =>
      credential?.key
        ? {
            auth: { apiKey: credential.key },
            ...(credential.env ? { env: credential.env } : {}),
            source: "stored credential",
          }
        : undefined,
  }
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

// ── Settings Keys Own Provider And Credential Identity ──────────
// Pi's built-in catalogs name adapters such as `openai-codex` and
// `kimi-coding`, but operators name configured routes for their engagement.
// The configured key must therefore become the Provider id and every model's
// provider field so authentication, status, fallback affinity, and credential
// storage all resolve through `cyberful auth login <key>`. The adapter remains
// host-owned metadata and cannot be selected by an AgentRun.
// ─────────────────────────────────────────────────────────────────
function configuredBuiltinProvider(
  id: string,
  provider: Provider,
  auth: ProviderAuth,
  settings: ProviderSettings,
): Provider {
  if (provider.refreshModels || provider.filterModels)
    throw new Error(`Pi provider adapter '${provider.id}' cannot be aliased because its model catalog is dynamic`)
  return {
    id,
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    auth,
    getModels: () =>
      provider.getModels().map((model) => {
        const contextWindow =
          settings.context_window === undefined
            ? model.contextWindow
            : Math.min(settings.context_window, model.contextWindow)
        const maxTokens =
          settings.max_output_tokens === undefined
            ? model.maxTokens
            : Math.min(settings.max_output_tokens, model.maxTokens)
        return {
          ...model,
          provider: id,
          contextWindow,
          maxTokens,
        }
      }),
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
  }
}

function declaredProvider(id: string, settings: ProviderSettings): Provider {
  if (settings.adapter === "openai-completions") return customOpenAIProvider(id, settings)
  const provider = builtinProviders().find((candidate) => candidate.id === settings.adapter)
  if (!provider) throw new Error(`Unknown Pi provider adapter '${settings.adapter}'`)
  if (!provider.getModels().some((model) => model.id === settings.model))
    throw new Error(`Model '${settings.model}' is not present in Pi provider '${id}'`)
  if (settings.auth.type === "subscription") {
    if (!SUBSCRIPTION_ADAPTERS.has(settings.adapter))
      throw new Error(`Pi provider '${id}' does not support Cyberful subscription login`)
    if (!provider.auth.oauth?.login && !provider.auth.apiKey?.login)
      throw new Error(`Pi provider '${id}' does not expose an interactive subscription login`)
    const oauth = provider.auth.oauth
    const apiKey = provider.auth.apiKey
    const auth = oauth?.login ? { oauth } : apiKey?.login ? { apiKey: storedApiKeyAuth(apiKey) } : undefined
    if (!auth) throw new Error(`Pi provider '${id}' does not expose an interactive subscription login`)
    return configuredBuiltinProvider(id, provider, auth, settings)
  }
  if (!provider.auth.apiKey)
    throw new Error(`Pi provider '${id}' does not support environment API-key authentication`)
  return configuredBuiltinProvider(id, provider, {
    apiKey: envApiKeyAuth(provider.auth.apiKey.name, [settings.auth.variable]),
  }, settings)
}

export interface PiModels {
  readonly models: Models
  model(providerID: string): Model<Api>
  contextCapacity(providerID: string): ModelContextCapacity
  adapter(providerID: string): string
  loginType(providerID: string): AuthType
}

// Pi core supplies no default prompt. Cyberful admits only reviewed adapters
// with a dedicated system/instructions channel; new provider extensions must
// be reviewed before joining this allowlist.
export function assertAuthenticSystemChannel(adapter: string, model: Model<Api>): void {
  const valid =
    (adapter === "openai-codex" && model.api === "openai-codex-responses") ||
    (adapter === "openai-completions" && model.api === "openai-completions") ||
    (adapter === "zai" && model.api === "openai-completions") ||
    (adapter === "kimi-coding" && model.api === "anthropic-messages") ||
    (adapter === "moonshotai" && model.api === "openai-completions")
  if (!valid)
    throw new Error(
      `Pi adapter '${adapter}' with API '${model.api}' is not approved to preserve Cyberful's system message`,
    )
}

export function createPiModels(settings: AgentProviderSettings, credentials: CredentialStore): PiModels {
  const main = settings.providers[settings.main_provider]
  if (!main) throw new Error(`Main provider '${settings.main_provider}' is not configured`)
  if (!MAIN_ADAPTERS.has(main.adapter))
    throw new Error(`Pi adapter '${main.adapter}' is not approved as Cyberful's main provider`)

  const models: MutableModels = createModels({ credentials })
  models.clearProviders()
  for (const [id, providerSettings] of Object.entries(settings.providers))
    models.setProvider(declaredProvider(id, providerSettings))

  const contextCapacity = (providerID: string): ModelContextCapacity => {
    const configured = settings.providers[providerID]
    if (!configured) throw new Error(`Provider '${providerID}' is not configured`)
    const model = models.getModel(providerID, configured.model)
    if (!model) throw new Error(`Model '${configured.model}' is not available from provider '${providerID}'`)
    const warnings: string[] = []
    const catalogModel =
      configured.adapter === "openai-completions"
        ? model
        : builtinProviders()
            .find((candidate) => candidate.id === configured.adapter)
            ?.getModels()
            .find((candidate) => candidate.id === configured.model)
    const catalogContextWindow = catalogModel?.contextWindow ?? model.contextWindow
    const trustedRouteWindow = model.contextWindow
    if (
      configured.context_window !== undefined &&
      configured.context_window > catalogContextWindow &&
      configured.adapter !== "openai-completions"
    )
      warnings.push(
        `context_window ${configured.context_window} exceeds catalog limit ${catalogContextWindow} and was ignored`,
      )
    const requestedOperational =
      configured.operational_context_window ??
      Math.min(trustedRouteWindow, DEFAULT_OPERATIONAL_CONTEXT_WINDOW)
    const operationalContextWindow = Math.min(requestedOperational, trustedRouteWindow)
    if (requestedOperational > trustedRouteWindow)
      warnings.push(
        `operational_context_window ${requestedOperational} exceeds trusted route limit ${trustedRouteWindow} and was clamped`,
      )
    const source: ModelContextCapacity["source"] =
      configured.operational_context_window !== undefined
        ? configured.operational_context_window > trustedRouteWindow
          ? "configured_operational_clamped"
          : "configured_operational"
        : configured.context_window !== undefined && configured.context_window < catalogContextWindow
          ? "catalog_restricted"
          : "catalog_default"
    return {
      catalogContextWindow,
      ...(configured.context_window === undefined
        ? {}
        : { configuredContextWindow: configured.context_window }),
      trustedRouteWindow,
      ...(configured.operational_context_window === undefined
        ? {}
        : { configuredOperationalContextWindow: configured.operational_context_window }),
      operationalContextWindow,
      source,
      warnings,
    }
  }

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
    contextCapacity,
    adapter(providerID) {
      const configured = settings.providers[providerID]
      if (!configured) throw new Error(`Provider '${providerID}' is not configured`)
      return configured.adapter
    },
    loginType(providerID) {
      const configured = settings.providers[providerID]
      if (!configured) throw new Error(`Provider '${providerID}' is not configured`)
      if (configured.auth.type !== "subscription")
        throw new Error(`Provider '${providerID}' is not configured for subscription login`)
      const provider = models.getProvider(providerID)
      if (!provider) throw new Error(`Provider '${providerID}' is not available`)
      if (provider.auth.oauth?.login) return "oauth"
      if (provider.auth.apiKey?.login) return "api_key"
      throw new Error(`Provider '${providerID}' does not expose an interactive subscription login`)
    },
  }
}

export * as SubsystemPiModels from "./pi-models"
