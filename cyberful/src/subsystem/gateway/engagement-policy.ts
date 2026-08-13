// ── Host-Enforced Engagement Policy ─────────────────────────────
// Stores the Brief's non-secret readiness and HTTP traffic projection and
//   applies host-scoped ZAP rate-limit and required-header rules.
// → cyberful/src/subsystem/zap/runtime.ts — reapplies the rules to each fresh phase runtime.
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
const RATE_LIMIT_DESCRIPTION = "Cyberful engagement global HTTP budget"
const REQUIRED_HEADER_DESCRIPTION_PREFIX = "Cyberful engagement required header: "
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
])

export interface EngagementRequiredHttpHeader {
  readonly name: string
  readonly value: string
  readonly hosts: readonly string[]
}

export interface EngagementPolicy {
  readonly version: 1
  readonly stage: "traffic" | "final"
  readonly updated_at: string
  readonly profiles: ReadonlyArray<{
    readonly profile: number
    readonly readiness: "READY" | "BLOCKED"
    readonly scope: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNRESOLVED"
    readonly origin?: string
  }>
  readonly authorized_http_hosts: readonly string[]
  readonly global_http_rps: number | null
  readonly required_http_headers: readonly EngagementRequiredHttpHeader[]
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

function hostIsAuthorized(host: string, authorizedHosts: readonly string[]) {
  if (authorizedHosts.includes(host)) return true
  if (host.startsWith("*.")) return false
  return authorizedHosts.some(
    (authorized) =>
      authorized.startsWith("*.") &&
      host.endsWith(`.${authorized.slice(2)}`) &&
      host !== authorized.slice(2),
  )
}

function requiredHttpHeader(
  value: unknown,
  index: number,
  authorizedHosts: readonly string[],
): EngagementRequiredHttpHeader {
  if (!isRecord(value)) throw new Error(`required_http_headers[${index}] must be an object`)
  if (typeof value.name !== "string") throw new Error(`required_http_headers[${index}].name must be a string`)
  const name = value.name.trim()
  if (!name || name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
    throw new Error(`required_http_headers[${index}].name is invalid`)
  const normalizedName = name.toLowerCase()
  if (
    SENSITIVE_REQUEST_HEADERS.has(normalizedName) ||
    /(?:^|-)(?:api-?key|password|secret|token)(?:-|$)/i.test(normalizedName)
  )
    throw new Error(`required_http_headers[${index}].name must identify a non-secret public header`)
  if (typeof value.value !== "string") throw new Error(`required_http_headers[${index}].value must be a string`)
  const headerValue = value.value.trim()
  if (
    !headerValue ||
    headerValue.length > 2_000 ||
    /[\u0000-\u001f\u007f]/.test(headerValue) ||
    /\{\{\s*var:|\[session-variable:/i.test(headerValue)
  )
    throw new Error(`required_http_headers[${index}].value must be a non-secret public value`)
  if (!Array.isArray(value.hosts) || value.hosts.length === 0 || value.hosts.length > 64)
    throw new Error(`required_http_headers[${index}].hosts must contain 1..64 authorized host patterns`)
  const hosts = [...new Set(value.hosts.map((host, hostIndex) => hostPattern(host, hostIndex)))]
  if (hosts.some((host) => !hostIsAuthorized(host, authorizedHosts)))
    throw new Error(`required_http_headers[${index}].hosts must be covered by authorized_http_hosts`)
  return { name, value: headerValue, hosts }
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
  const stage = value.stage === undefined ? "final" : value.stage
  if (stage !== "traffic" && stage !== "final") throw new Error("engagement policy stage is invalid")
  const hosts = value.authorized_http_hosts.map(hostPattern)
  if (globalRps !== null && hosts.length === 0)
    throw new Error("engagement policy requires authorized HTTP hosts when global_http_rps is set")
  const headerValues = value.required_http_headers === undefined ? [] : value.required_http_headers
  if (!Array.isArray(headerValues) || headerValues.length > 16)
    throw new Error("engagement policy required_http_headers must contain at most 16 entries")
  const headers = headerValues.map((header, index) => requiredHttpHeader(header, index, hosts))
  const duplicateHeader = headers.find(
    (header, index) => headers.findIndex((candidate) => candidate.name.toLowerCase() === header.name.toLowerCase()) !== index,
  )
  if (duplicateHeader) throw new Error(`required_http_headers contains duplicate name ${duplicateHeader.name}`)
  return {
    version: 1,
    stage,
    updated_at: value.updated_at,
    profiles: value.profiles.map(profile),
    authorized_http_hosts: [...new Set(hosts)],
    global_http_rps: globalRps,
    required_http_headers: headers,
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

export function engagementPolicyRequiresZap(
  policy?: Partial<Pick<EngagementPolicy, "global_http_rps" | "required_http_headers">>,
) {
  return (
    (policy?.global_http_rps !== null && policy?.global_http_rps !== undefined) ||
    (policy?.required_http_headers?.length ?? 0) > 0
  )
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
  return `^https?://(?:${alternatives.join("|")})(?::[0-9]+)?(?:[/?#].*)?$`
}

interface ZapDiagnostic {
  readonly code?: string
  readonly message?: string
  readonly detail?: string
}

interface ZapValidationDiagnostic {
  readonly code: string
  readonly message?: string
  readonly responseShape?: SanitizedResponseShape
}

interface SanitizedResponseShape {
  readonly type: "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined"
  readonly length?: number
  readonly fields?: Readonly<Record<string, string>>
  readonly truncated?: boolean
}

function responseValueShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

function sanitizedResponseShape(value: unknown): SanitizedResponseShape {
  if (value === null) return { type: "null" }
  if (Array.isArray(value)) return { type: "array", length: value.length }
  if (!isRecord(value)) return { type: typeof value as SanitizedResponseShape["type"] }
  const keys = Object.keys(value).sort()
  const retained = keys.slice(0, 20)
  return {
    type: "object",
    fields: Object.fromEntries(retained.map((key) => [key.slice(0, 80), responseValueShape(value[key])])),
    ...(keys.length > retained.length ? { truncated: true } : {}),
  }
}

function sanitizedZapText(value: unknown, apiKey: string) {
  if (typeof value !== "string") return
  const normalized = value
    .replaceAll(apiKey, "[redacted:api-key]")
    .replace(/\bapikey\s*=\s*[^&\s"'<>]+/gi, "apikey=[redacted]")
    .replace(/\bmatchString\s*=\s*[^&\s"'<>]+/gi, "matchString=[redacted]")
    .replace(/\breplacement\s*=\s*[^&\s"'<>]+/gi, "replacement=[redacted]")
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

export class ZapEngagementPolicyInstallError extends Error {
  readonly kind = "zap_engagement_policy_install_failed"
  readonly httpStatus?: number
  readonly zapCode?: string
  readonly zapMessage?: string
  readonly zapDetail?: string
  readonly validationCode?: string
  readonly validationMessage?: string
  readonly responseShape?: SanitizedResponseShape

  constructor(input: {
    readonly httpStatus?: number
    readonly diagnostic?: ZapDiagnostic
    readonly validation?: ZapValidationDiagnostic
  }) {
    const status = input.httpStatus === undefined ? "transport failure" : `HTTP ${input.httpStatus}`
    const code = input.diagnostic?.code
      ? `; ZAP ${input.diagnostic.code}`
      : input.validation?.code
        ? `; Cyberful ${input.validation.code}`
        : ""
    super(`could not install the engagement ZAP traffic policy (${status}${code})`)
    this.name = "ZapEngagementPolicyInstallError"
    this.httpStatus = input.httpStatus
    this.zapCode = input.diagnostic?.code
    this.zapMessage = input.diagnostic?.message
    this.zapDetail = input.diagnostic?.detail
    this.validationCode = input.validation?.code
    this.validationMessage = input.validation?.message
    this.responseShape = input.validation?.responseShape
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
      ...(this.validationCode ? { validation_code: this.validationCode } : {}),
      ...(this.validationMessage ? { validation_message: this.validationMessage } : {}),
      ...(this.responseShape ? { response_shape: this.responseShape } : {}),
      action:
        "Record this host-runtime blocker and stop Brief without handoff. Do not retry or ask the operator to restore ZAP.",
    }
  }
}

async function zapNetworkRequest(
  pathname: string,
  parameters: Record<string, string>,
  input: { readonly proxyUrl: string; readonly apiKey: string; readonly signal?: AbortSignal },
) {
  const endpoint = new URL(pathname, input.proxyUrl)
  endpoint.searchParams.set("apikey", input.apiKey)
  for (const [name, value] of Object.entries(parameters)) endpoint.searchParams.set(name, value)
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { Host: ZAP_API_HOST },
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    })
  } catch {
    input.signal?.throwIfAborted()
    throw new ZapEngagementPolicyInstallError({ validation: { code: "transport_error" } })
  }
  const body = await response.text()
  const diagnostic = zapDiagnostic(body, input.apiKey)
  if (!response.ok || diagnostic.code)
    throw new ZapEngagementPolicyInstallError({ httpStatus: response.status, diagnostic })
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new ZapEngagementPolicyInstallError({
      httpStatus: response.status,
      validation: { code: "invalid_json", message: "ZAP returned a non-JSON network response" },
    })
  }
}

function matchingRateLimitRules(value: unknown) {
  const registry = isRecord(value)
    ? value.getRateLimitRules === undefined
      ? value.rateLimitRules
      : value.getRateLimitRules
    : undefined
  if (!Array.isArray(registry))
    throw new ZapEngagementPolicyInstallError({
      validation: {
        code: "invalid_rule_registry",
        message: "ZAP Network API did not return a rate-limit rule array",
        responseShape: sanitizedResponseShape(value),
      },
    })
  return registry.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.description === RATE_LIMIT_DESCRIPTION,
  )
}

function matchingRequiredHeaderRules(value: unknown) {
  const registry = isRecord(value) ? value.rules : undefined
  if (!Array.isArray(registry))
    throw new ZapEngagementPolicyInstallError({
      validation: {
        code: "invalid_replacer_registry",
        message: "ZAP Replacer API did not return a rule array",
        responseShape: sanitizedResponseShape(value),
      },
    })
  return registry.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      typeof candidate.description === "string" &&
      candidate.description.startsWith(REQUIRED_HEADER_DESCRIPTION_PREFIX),
  )
}

function requiredHeaderDescription(header: EngagementRequiredHttpHeader) {
  return `${REQUIRED_HEADER_DESCRIPTION_PREFIX}${header.name.toLowerCase()}`
}

function disabled(value: unknown) {
  return value === false || String(value).toLowerCase() === "false"
}

function enabled(value: unknown) {
  return value === true || String(value).toLowerCase() === "true"
}

function rateLimitRuleMatches(rule: Readonly<Record<string, unknown>>, policy: EngagementPolicy) {
  return (
    rule.description === RATE_LIMIT_DESCRIPTION &&
    enabled(rule.enabled) &&
    enabled(rule.matchRegex) &&
    rule.matchString === rateLimitRegex(policy.authorized_http_hosts) &&
    Number(rule.requestsPerSecond) === policy.global_http_rps &&
    String(rule.groupBy).toLowerCase() === "rule"
  )
}

function requiredHeaderRuleMatches(
  rule: Readonly<Record<string, unknown>>,
  header: EngagementRequiredHttpHeader,
) {
  return (
    rule.description === requiredHeaderDescription(header) &&
    rule.matchType === "REQ_HEADER" &&
    disabled(rule.matchRegex) &&
    rule.matchString === header.name &&
    rule.replacement === header.value &&
    rule.url === rateLimitRegex(header.hosts) &&
    enabled(rule.enabled)
  )
}

export type EngagementTrafficEnforcement = {
  readonly state: "enforced"
  readonly rate_limit:
    | { readonly state: "not_required" }
    | {
        readonly state: "configured"
        readonly requests_per_second: number
        readonly hosts: readonly string[]
        readonly group_by: "rule"
      }
  readonly required_headers:
    | { readonly state: "not_required"; readonly count: 0 }
    | {
        readonly state: "configured"
        readonly count: number
        readonly names: readonly string[]
        readonly hosts: readonly string[]
      }
}

// ── ZAP Owns Every HTTP Traffic Invariant ────────────────────────
// Browser profiles, ZAP replays, and proxy-aware clients all cross the same
// host-scoped controls. The Network add-on shares one rate counter across the
// authorized hosts, while Replacer adds only public program-required request
// headers to their declared hosts. Absence of either requirement is explicitly
// attested as not_required instead of being reported as failed configuration.
//
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────
export async function applyEngagementTrafficPolicy(
  policy: EngagementPolicy | undefined,
  input: { readonly proxyUrl: string; readonly apiKey: string; readonly signal?: AbortSignal },
): Promise<EngagementTrafficEnforcement> {
  const existingRateLimits = matchingRateLimitRules(
    await zapNetworkRequest("/JSON/network/view/getRateLimitRules/", {}, input),
  )
  if (existingRateLimits.length > 0)
    await zapNetworkRequest(
      "/JSON/network/action/removeRateLimitRule/",
      { description: RATE_LIMIT_DESCRIPTION },
      input,
    )
  const existingHeaders = matchingRequiredHeaderRules(
    await zapNetworkRequest("/JSON/replacer/view/rules/", {}, input),
  )
  for (const rule of existingHeaders) {
    await zapNetworkRequest(
      "/JSON/replacer/action/removeRule/",
      { description: String(rule.description) },
      input,
    )
  }

  if (policy?.global_http_rps !== null && policy?.global_http_rps !== undefined)
    await zapNetworkRequest(
      "/JSON/network/action/addRateLimitRule/",
      {
        description: RATE_LIMIT_DESCRIPTION,
        enabled: "true",
        matchRegex: "true",
        matchString: rateLimitRegex(policy.authorized_http_hosts),
        requestsPerSecond: String(policy.global_http_rps),
        groupBy: "rule",
      },
      input,
    )
  for (const header of policy?.required_http_headers ?? []) {
    await zapNetworkRequest(
      "/JSON/replacer/action/addRule/",
      {
        description: requiredHeaderDescription(header),
        enabled: "true",
        matchType: "REQ_HEADER",
        matchRegex: "false",
        matchString: header.name,
        replacement: header.value,
        url: rateLimitRegex(header.hosts),
      },
      input,
    )
  }

  const installedRateLimits = matchingRateLimitRules(
    await zapNetworkRequest("/JSON/network/view/getRateLimitRules/", {}, input),
  )
  const expectedRateLimitCount = policy?.global_http_rps === null || policy?.global_http_rps === undefined ? 0 : 1
  if (
    installedRateLimits.length !== expectedRateLimitCount ||
    (policy?.global_http_rps !== null &&
      policy?.global_http_rps !== undefined &&
      !installedRateLimits.some((rule) => rateLimitRuleMatches(rule, policy)))
  )
    throw new ZapEngagementPolicyInstallError({
      validation: {
        code: "rate_limit_attestation_failed",
        message: `expected ${expectedRateLimitCount} exact Cyberful rate-limit rules`,
      },
    })
  const installedHeaders = matchingRequiredHeaderRules(
    await zapNetworkRequest("/JSON/replacer/view/rules/", {}, input),
  )
  const expectedHeaders = policy?.required_http_headers ?? []
  if (
    installedHeaders.length !== expectedHeaders.length ||
    expectedHeaders.some((header) => !installedHeaders.some((rule) => requiredHeaderRuleMatches(rule, header)))
  )
    throw new ZapEngagementPolicyInstallError({
      validation: {
        code: "required_header_attestation_failed",
        message: `expected ${expectedHeaders.length} exact Cyberful required-header rules`,
      },
    })
  return {
    state: "enforced",
    rate_limit:
      policy?.global_http_rps === null || policy?.global_http_rps === undefined
        ? { state: "not_required" }
        : {
            state: "configured",
            requests_per_second: policy.global_http_rps,
            hosts: policy.authorized_http_hosts,
            group_by: "rule",
          },
    required_headers:
      expectedHeaders.length === 0
        ? { state: "not_required", count: 0 }
        : {
            state: "configured",
            count: expectedHeaders.length,
            names: expectedHeaders.map((header) => header.name),
            hosts: [...new Set(expectedHeaders.flatMap((header) => header.hosts))],
          },
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

  prepareTraffic(args: Record<string, unknown>) {
    if (args.action !== "configure") throw new Error("engagement_policy action must be configure")
    if (args.profiles !== undefined) throw new Error("engagement_policy configure does not accept profiles")
    return parse({
      version: 1,
      stage: "traffic",
      updated_at: new Date().toISOString(),
      profiles: [],
      authorized_http_hosts: args.authorized_http_hosts,
      global_http_rps: args.global_http_rps,
      required_http_headers: args.required_http_headers,
    })
  }

  finalize(current: EngagementPolicy | undefined, args: Record<string, unknown>) {
    if (args.action !== "finalize") throw new Error("engagement_policy action must be finalize")
    if (!current) throw new Error("engagement_policy finalize requires configure to succeed first")
    if (
      args.authorized_http_hosts !== undefined ||
      args.global_http_rps !== undefined ||
      args.required_http_headers !== undefined
    )
      throw new Error("engagement_policy finalize accepts only profiles")
    return parse({
      ...current,
      stage: "final",
      updated_at: new Date().toISOString(),
      profiles: args.profiles,
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
    "Brief-owned two-stage non-secret HTTP policy. Call configure before any numbered target-profile status or navigation so ZAP can attest authorized hosts, an optional aggregate requests-per-second limit, and public required request headers. Call finalize after profile readiness is known. retryable=false is a terminal host-runtime blocker for this Brief and never requires human repair.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["configure", "finalize", "get"] },
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
      required_http_headers: {
        type: "array",
        maxItems: 16,
        description:
          "Public, non-secret request headers mandated by the engagement policy. Secret-bearing authorization, cookie, key, token, password, and secret headers are rejected.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            hosts: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
          },
          required: ["name", "value", "hosts"],
        },
      },
    },
    required: ["action"],
  },
}

export * as GatewayEngagementPolicy from "./engagement-policy"
