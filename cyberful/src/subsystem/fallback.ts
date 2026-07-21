// ── Local Fallback Inference Boundary ────────────────────────────
// Loads the operator-owned fallback-server.yaml exactly once for an engagement,
// validates its local-only trust boundary, resolves optional authentication from
// the host environment, and probes the Responses-compatible server without
// turning temporary unavailability into a primary-runtime failure.
// → cyberful/src/session/prompt.ts — resolves this launch-directory configuration.
// → cyberful/src/subsystem/phase-runner.ts — consumes the immutable resolution.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { isRecord } from "@/util/record"

const CONFIG_FILE = "fallback-server.yaml"
const MAX_SYSTEM_PROMPT_BYTES = 8 * 1024
const PREFLIGHT_TIMEOUT_MS = 5_000
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export const DEFAULT_SYSTEM_PROMPT = [
  "You are the local fallback controller for an authorized security test.",
  "Complete the supplied bounded operation inside the exact engagement scope.",
  "Use durable workarea evidence, verify ambiguous prior effects before replay,",
  "and preserve every approval decision already supplied by the human.",
].join(" ")

export interface Config {
  readonly version: 1
  readonly enabled: true
  readonly protocol: "openai-responses"
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnvironment?: string
  readonly systemPrompt: string
}

export type RuntimeConfig = Config

export type Resolution =
  | { readonly status: "disabled"; readonly reason: "missing"; readonly warning: string }
  | { readonly status: "disabled"; readonly reason: "configured-off" }
  | { readonly status: "unavailable"; readonly config: RuntimeConfig; readonly warning: string }
  | { readonly status: "available"; readonly config: RuntimeConfig }

interface LoadOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

function configurationError(message: string): Error {
  return new Error(`${CONFIG_FILE}: ${message}`)
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw configurationError("base_url must be a non-empty string")
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw configurationError(`base_url is not a valid URL: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!new Set(["http:", "https:"]).has(url.protocol))
    throw configurationError("base_url must use http or https")
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw configurationError("base_url must target localhost or a loopback IP")
  if (url.username || url.password) throw configurationError("base_url must not contain credentials")
  if (url.search || url.hash) throw configurationError("base_url must not contain a query or fragment")
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname !== "/v1") throw configurationError("base_url must end at the OpenAI-compatible /v1 root")
  url.pathname = pathname
  return url.toString().replace(/\/$/, "")
}

function parseSystemPrompt(value: unknown): string {
  if (value === undefined) return DEFAULT_SYSTEM_PROMPT
  if (typeof value !== "string" || !value.trim())
    throw configurationError("system_prompt must be a non-empty string when supplied")
  if (new TextEncoder().encode(value).byteLength > MAX_SYSTEM_PROMPT_BYTES)
    throw configurationError(`system_prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} UTF-8 bytes`)
  return value.trim()
}

export function parse(value: unknown): Config | { readonly enabled: false } {
  if (!isRecord(value)) throw configurationError("document must be a YAML object")
  const accepted = new Set(["version", "enabled", "protocol", "base_url", "model", "api_key_env", "system_prompt"])
  const unknown = Object.keys(value).filter((key) => !accepted.has(key))
  if (unknown.length) throw configurationError(`unknown key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`)
  if (value.version !== 1) throw configurationError("version must be 1")
  if (typeof value.enabled !== "boolean") throw configurationError("enabled must be true or false")
  if (!value.enabled) return { enabled: false }
  if (value.protocol !== "openai-responses") throw configurationError("protocol must be openai-responses")
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200)
    throw configurationError("model must be a non-empty string of at most 200 characters")
  if (
    value.api_key_env !== undefined &&
    (typeof value.api_key_env !== "string" || !ENVIRONMENT_NAME.test(value.api_key_env))
  )
    throw configurationError("api_key_env must be an uppercase environment variable name")
  return {
    version: 1,
    enabled: true,
    protocol: "openai-responses",
    baseUrl: parseBaseUrl(value.base_url),
    model: value.model.trim(),
    ...(typeof value.api_key_env === "string" ? { apiKeyEnvironment: value.api_key_env } : {}),
    systemPrompt: parseSystemPrompt(value.system_prompt),
  }
}

function resolvedSecret(config: Config, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!config.apiKeyEnvironment) return
  const apiKey = environment[config.apiKeyEnvironment]
  if (!apiKey) throw configurationError(`environment variable ${config.apiKeyEnvironment} is not set`)
  return apiKey
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`
}

async function preflight(
  config: RuntimeConfig,
  request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  apiKey?: string,
): Promise<string | undefined> {
  try {
    const response = await request(modelsUrl(config.baseUrl), {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    })
    if (response.ok) return
    return `Local fallback inference server returned HTTP ${response.status} during preflight; the primary run will continue without delegate_to_fallback_inference.`
  } catch (error) {
    return `Local fallback inference server is unavailable (${error instanceof Error ? error.message : String(error)}); the primary run will continue without delegate_to_fallback_inference.`
  }
}

// ── Unavailability Degrades One Engagement, Not Its Primary Run ────
// A syntactically valid enabled file is an operator request to offer fallback,
// but a stopped local daemon must not prevent the normal provider from working.
// The probe therefore freezes availability for this engagement: a failed probe
// produces a warning and no dynamic tool, while invalid policy still fails fast.
// No background re-probe or telemetry is started after this boundary returns.
// ─────────────────────────────────────────────────────────────────
export async function load(launchDirectory: string, options: LoadOptions = {}): Promise<Resolution> {
  const configPath = path.join(launchDirectory, CONFIG_FILE)
  const file = Bun.file(configPath)
  if (!(await file.exists()))
    return {
      status: "disabled",
      reason: "missing",
      warning: `${CONFIG_FILE} is missing; local fallback inference is disabled for this run.`,
    }
  let decoded: unknown
  try {
    decoded = Bun.YAML.parse(await file.text())
  } catch (error) {
    throw configurationError(`could not parse YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = parse(decoded)
  if (!config.enabled) return { status: "disabled", reason: "configured-off" }
  const apiKey = resolvedSecret(config, options.environment ?? process.env)
  const warning = await preflight(config, options.request ?? fetch, apiKey)
  return warning ? { status: "unavailable", config, warning } : { status: "available", config }
}

export function publicDescriptor(resolution: Resolution) {
  if (resolution.status === "disabled") return { status: resolution.status, reason: resolution.reason } as const
  return {
    status: resolution.status,
    protocol: resolution.config.protocol,
    model: resolution.config.model,
  } as const
}

export * as SubsystemFallback from "./fallback"
