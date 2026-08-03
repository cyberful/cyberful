// ── Host-Enforced Engagement Policy ─────────────────────────────
// Stores the Brief's non-secret readiness and HTTP authority projection and
//   applies one global ZAP rate-limit rule across matching authorized hosts.
// → cyberful/src/subsystem/zap/runtime.ts — reapplies the rule to each fresh phase runtime.
// → cyberful/src/subsystem/gateway/server.ts — exposes the Brief-owned policy tool.
// @docs/runtimes/zap.md
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { readFile } from "node:fs/promises"
import { isRecord } from "@/util/record"
import { replaceWorkareaFile } from "@/workarea"

export const ENGAGEMENT_POLICY_PATH = "raw/policy/engagement.json"
const ZAP_API_HOST = "zap"
const ZAP_DIAGNOSTIC_LIMIT = 300

export interface EngagementPolicy {
  readonly version: 1
  readonly updated_at: string
  readonly profiles: ReadonlyArray<{
    readonly profile: number
    readonly readiness: "READY" | "BLOCKED"
    readonly scope: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNRESOLVED"
    readonly origin?: string
  }>
  readonly authorized_http_hosts: readonly string[]
  readonly global_http_rps: number | null
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`)
  return normalized
}

function hostPattern(value: unknown, index: number) {
  const host = boundedText(value, `authorized_http_hosts[${index}]`, 253)
  const candidate = host.startsWith("*.") ? host.slice(2) : host
  if (
    !candidate.includes(".") ||
    !/^[a-z0-9.-]+$/.test(candidate) ||
    candidate.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))
  )
    throw new Error(`authorized_http_hosts[${index}] must be an exact host or *.domain wildcard`)
  return host
}

function profile(value: unknown, index: number): EngagementPolicy["profiles"][number] {
  if (!isRecord(value)) throw new Error(`profiles[${index}] must be an object`)
  if (typeof value.profile !== "number" || !Number.isInteger(value.profile) || value.profile < 1 || value.profile > 5)
    throw new Error(`profiles[${index}].profile must be between 1 and 5`)
  if (value.readiness !== "READY" && value.readiness !== "BLOCKED")
    throw new Error(`profiles[${index}].readiness is invalid`)
  if (!["IN_SCOPE", "OUT_OF_SCOPE", "UNRESOLVED"].includes(String(value.scope)))
    throw new Error(`profiles[${index}].scope is invalid`)
  let origin: string | undefined
  if (value.origin !== undefined) {
    const parsed = new URL(boundedText(value.origin, `profiles[${index}].origin`, 2_000))
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`profiles[${index}].origin must use HTTP(S)`)
    origin = parsed.origin
  }
  return {
    profile: value.profile,
    readiness: value.readiness,
    scope: value.scope as EngagementPolicy["profiles"][number]["scope"],
    ...(origin ? { origin } : {}),
  }
}

function parse(value: unknown): EngagementPolicy {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles))
    throw new Error("engagement policy is invalid")
  if (!Array.isArray(value.authorized_http_hosts))
    throw new Error("engagement policy authorized_http_hosts is invalid")
  const globalRps =
    value.global_http_rps === null
      ? null
      : typeof value.global_http_rps === "number" &&
          Number.isInteger(value.global_http_rps) &&
          value.global_http_rps >= 1 &&
          value.global_http_rps <= 1_000
        ? value.global_http_rps
        : undefined
  if (globalRps === undefined) throw new Error("engagement policy global_http_rps must be null or 1..1000")
  if (typeof value.updated_at !== "string") throw new Error("engagement policy timestamp is invalid")
  const hosts = value.authorized_http_hosts.map(hostPattern)
  if (globalRps !== null && hosts.length === 0)
    throw new Error("engagement policy requires authorized HTTP hosts when global_http_rps is set")
  return {
    version: 1,
    updated_at: value.updated_at,
    profiles: value.profiles.map(profile),
    authorized_http_hosts: [...new Set(hosts)],
    global_http_rps: globalRps,
  }
}

export async function readEngagementPolicy(workarea: string): Promise<EngagementPolicy | undefined> {
  const content = await readFile(path.join(workarea, ENGAGEMENT_POLICY_PATH), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  return content === undefined ? undefined : parse(JSON.parse(content))
}

function regexEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function rateLimitRegex(hosts: readonly string[]) {
  const alternatives = hosts.map((host) =>
    host.startsWith("*.")
      ? `(?:[^./:]+\\.)+${regexEscape(host.slice(2))}`
      : regexEscape(host),
  )
  return `^https?://(?:${alternatives.join("|")})(?::[0-9]+)?(?:/|$)`
}

interface ZapDiagnostic {
  readonly code?: string
  readonly message?: string
  readonly detail?: string
}

function sanitizedZapText(value: unknown, apiKey: string) {
  if (typeof value !== "string") return
  const normalized = value
    .replaceAll(apiKey, "[redacted:api-key]")
    .replace(/\bapikey\s*=\s*[^&\s"'<>]+/gi, "apikey=[redacted]")
    .replace(/\bmatchString\s*=\s*[^&\s"'<>]+/gi, "matchString=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted:url]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return
  return normalized.slice(0, ZAP_DIAGNOSTIC_LIMIT)
}

function zapDiagnostic(body: string, apiKey: string): ZapDiagnostic {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { message: sanitizedZapText(body, apiKey) }
  }
  if (!isRecord(value)) return {}
  return {
    code: sanitizedZapText(value.code ?? value.error, apiKey),
    message: sanitizedZapText(value.message, apiKey),
    detail: sanitizedZapText(value.detail, apiKey),
  }
}

export class ZapRateLimitInstallError extends Error {
  readonly kind = "zap_rate_limit_install_failed"
  readonly httpStatus?: number
  readonly zapCode?: string
  readonly zapMessage?: string
  readonly zapDetail?: string

  constructor(input: { readonly httpStatus?: number; readonly diagnostic?: ZapDiagnostic }) {
    const status = input.httpStatus === undefined ? "transport failure" : `HTTP ${input.httpStatus}`
    const code = input.diagnostic?.code ? `; ZAP ${input.diagnostic.code}` : ""
    super(`could not install the engagement ZAP rate-limit rule (${status}${code})`)
    this.name = "ZapRateLimitInstallError"
    this.httpStatus = input.httpStatus
    this.zapCode = input.diagnostic?.code
    this.zapMessage = input.diagnostic?.message
    this.zapDetail = input.diagnostic?.detail
  }

  toolResult() {
    return {
      error: this.message,
      code: this.kind,
      retryable: false,
      user_action_required: false,
      policy_stored: false,
      ...(this.httpStatus === undefined ? {} : { http_status: this.httpStatus }),
      ...(this.zapCode ? { zap_code: this.zapCode } : {}),
      ...(this.zapMessage ? { zap_message: this.zapMessage } : {}),
      ...(this.zapDetail ? { zap_detail: this.zapDetail } : {}),
      action:
        "Record this host-runtime blocker and stop Brief without handoff. Do not retry or ask the operator to restore ZAP.",
    }
  }
}

// ── One ZAP Rule Owns The Aggregate HTTP Budget ─────────────────
// Browser profiles, ZAP replays, and proxy-aware clients all cross the same
// Network add-on rule. groupBy=rule deliberately shares one counter across
// every matching host instead of multiplying the advertised budget per host.
// A configured policy is hard: inability to install the rule aborts startup so
// a fresh phase cannot silently fall back to unthrottled target traffic.
//
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────
export async function applyEngagementRateLimit(
  policy: EngagementPolicy,
  input: { readonly proxyUrl: string; readonly apiKey: string; readonly signal?: AbortSignal },
) {
  if (policy.global_http_rps === null) return { configured: false as const }
  const endpoint = new URL("/JSON/network/action/addRateLimitRule/", input.proxyUrl)
  endpoint.searchParams.set("apikey", input.apiKey)
  endpoint.searchParams.set("description", "Cyberful engagement global HTTP budget")
  endpoint.searchParams.set("enabled", "true")
  endpoint.searchParams.set("matchRegex", "true")
  endpoint.searchParams.set("matchString", rateLimitRegex(policy.authorized_http_hosts))
  endpoint.searchParams.set("requestsPerSecond", String(policy.global_http_rps))
  endpoint.searchParams.set("groupBy", "rule")
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { Host: ZAP_API_HOST },
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    })
  } catch (error) {
    input.signal?.throwIfAborted()
    throw new ZapRateLimitInstallError({ diagnostic: { code: "transport_error" } })
  }
  const body = await response.text()
  const diagnostic = zapDiagnostic(body, input.apiKey)
  if (!response.ok || diagnostic.code)
    throw new ZapRateLimitInstallError({ httpStatus: response.status, diagnostic })
  return {
    configured: true as const,
    requests_per_second: policy.global_http_rps,
    hosts: policy.authorized_http_hosts,
    group_by: "rule" as const,
  }
}

export class EngagementPolicyStore {
  readonly #workarea: string

  constructor(workarea: string) {
    if (!path.isAbsolute(workarea)) throw new Error("engagement policy requires an absolute workarea root")
    this.#workarea = workarea
  }

  get() {
    return readEngagementPolicy(this.#workarea)
  }

  prepare(args: Record<string, unknown>) {
    if (args.action !== "set") throw new Error("engagement_policy action must be set")
    return parse({
      version: 1,
      updated_at: new Date().toISOString(),
      profiles: args.profiles,
      authorized_http_hosts: args.authorized_http_hosts,
      global_http_rps: args.global_http_rps,
    })
  }

  async commit(policy: EngagementPolicy) {
    const candidate = parse(policy)
    await replaceWorkareaFile(
      this.#workarea,
      ENGAGEMENT_POLICY_PATH,
      `${JSON.stringify(candidate, null, 2)}\n`,
      { mode: 0o600 },
    )
    return candidate
  }
}

export const ENGAGEMENT_POLICY_TOOL_DEF = {
  name: "engagement_policy",
  description:
    "Brief-owned non-secret projection of profile readiness, HTTP host authority, and the one aggregate HTTP requests-per-second limit enforced by ZAP. Call set once; retryable=false is a terminal host-runtime blocker for this Brief and never requires a human approval.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["set", "get"] },
      profiles: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            profile: { type: "integer", minimum: 1, maximum: 5 },
            readiness: { type: "string", enum: ["READY", "BLOCKED"] },
            scope: { type: "string", enum: ["IN_SCOPE", "OUT_OF_SCOPE", "UNRESOLVED"] },
            origin: { type: "string" },
          },
          required: ["profile", "readiness", "scope"],
        },
      },
      authorized_http_hosts: { type: "array", items: { type: "string" } },
      global_http_rps: { oneOf: [{ type: "integer", minimum: 1, maximum: 1_000 }, { type: "null" }] },
    },
    required: ["action"],
  },
}

export * as GatewayEngagementPolicy from "./engagement-policy"
