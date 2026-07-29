// ── Pi Provider Failure Classification ──────────────────────────
// Normalizes structured Pi and upstream provider failure evidence while keeping
// security-policy fallback admission limited to exact, provider-scoped signals.
// ─────────────────────────────────────────────────────────────────

export type FailureKind =
  | "security_policy_block"
  | "timeout"
  | "rate_limit"
  | "authentication"
  | "capacity"
  | "network"
  | "unavailable"
  | "malformed_output"
  | "cancelled"
  | "unknown"

export interface FailureObservation {
  readonly adapter: string
  readonly provider: string
  readonly model?: string
  readonly message?: unknown
  readonly upstream?: unknown
}

export type SecurityPolicyBlock = {
  readonly kind: "security_policy_block"
  readonly providerCode: "cyberPolicy" | "content_filter" | "sensitive"
  readonly evidence: "codex_error_code" | "openai_finish_reason" | "glm_finish_reason"
  /** Bounded, credential-redacted provider text for operators; never classification evidence. */
  readonly detail?: string
  readonly retryable: false
}

export type OrdinaryFailure = {
  readonly kind: Exclude<FailureKind, "security_policy_block">
  readonly providerCode?: string
  readonly httpStatus?: number
  /** Bounded, credential-redacted provider text for operators; never classification evidence. */
  readonly detail?: string
  readonly retryable: boolean
}

export type Failure = SecurityPolicyBlock | OrdinaryFailure

interface StructuredEvidence {
  readonly codes: readonly string[]
  readonly finishReasons: readonly string[]
  readonly httpStatuses: readonly number[]
  readonly stopReasons: readonly string[]
  readonly failed: boolean
}

const AUTHENTICATION_CODES = new Set([
  "auth",
  "authentication_error",
  "invalid_api_key",
  "invalid_token",
  "oauth",
  "unauthorized",
])
const CAPACITY_CODES = new Set([
  "context_length_exceeded",
  "insufficient_quota",
  "sessionBudgetExceeded",
  "usage_limit_reached",
  "usageLimitExceeded",
])
const MALFORMED_OUTPUT_CODES = new Set([
  "invalid_json",
  "invalid_response",
  "malformed_output",
  "missing_finish_reason",
  "parse_error",
])
const NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "httpConnectionFailed",
  "network_error",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
])
const RATE_LIMIT_CODES = new Set(["rate_limit", "rate_limit_exceeded", "too_many_requests"])
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "request_timeout",
  "responseTooManyFailedAttempts",
  "timeout",
])
const UNAVAILABLE_CODES = new Set([
  "1006",
  "server_error",
  "server_is_overloaded",
  "serverOverloaded",
  "service_unavailable",
  "temporarily_unavailable",
])
const NORMAL_FINISH_REASONS = new Set(["end", "function_call", "length", "stop", "tool_calls", "toolUse"])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(value: Record<string, unknown> | undefined, name: string): string | undefined {
  const field = value?.[name]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

function statusField(value: Record<string, unknown> | undefined, name: string): number | undefined {
  const field = value?.[name]
  return typeof field === "number" && Number.isInteger(field) ? field : undefined
}

function appendCode(codes: string[], value: unknown): void {
  if ((typeof value === "string" && value.length > 0) || typeof value === "number") codes.push(String(value))
}

function appendCodexInfo(codes: string[], value: unknown): void {
  if (typeof value === "string") {
    appendCode(codes, value)
    return
  }
  const info = record(value)
  if (info && Object.hasOwn(info, "cyberPolicy")) codes.push("cyberPolicy")
}

function appendFinishReasons(finishReasons: string[], value: Record<string, unknown> | undefined): void {
  const camelCase = stringField(value, "finishReason")
  const snakeCase = stringField(value, "finish_reason")
  if (camelCase) finishReasons.push(camelCase)
  if (snakeCase) finishReasons.push(snakeCase)
}

function appendStatuses(httpStatuses: number[], value: Record<string, unknown> | undefined): void {
  for (const name of ["status", "statusCode", "httpStatusCode"]) {
    const status = statusField(value, name)
    if (status !== undefined) httpStatuses.push(status)
  }
}

function inspectRecord(
  value: Record<string, unknown> | undefined,
  codes: string[],
  finishReasons: string[],
  httpStatuses: number[],
): boolean {
  if (!value) return false
  appendCode(codes, value.code)
  appendCode(codes, value.providerCode)
  appendCodexInfo(codes, value.codexErrorInfo)
  appendFinishReasons(finishReasons, value)
  appendStatuses(httpStatuses, value)

  const error = record(value.error)
  appendCode(codes, error?.code)
  appendCode(codes, error?.providerCode)
  appendCodexInfo(codes, error?.codexErrorInfo)
  appendFinishReasons(finishReasons, error)
  appendStatuses(httpStatuses, error)

  const choice = record(value.choice)
  appendFinishReasons(finishReasons, choice)
  const choices = Array.isArray(value.choices) ? value.choices : []
  for (const item of choices) appendFinishReasons(finishReasons, record(item))

  return value.error !== undefined || value.errorMessage !== undefined
}

// ── Security Fallback Requires Provider-Owned Evidence ──────────
// Model prose and display-oriented error strings are untrusted text, so this
// classifier never searches them for safety vocabulary. It inspects only fixed
// protocol fields and Pi diagnostic slots, then scopes each exact signal to the
// adapter or model family that defines it. Ordinary failures remain normalized
// for audit and rendering but can never acquire security fallback semantics.
// ─────────────────────────────────────────────────────────────────
function evidence(observation: FailureObservation): StructuredEvidence {
  const codes: string[] = []
  const finishReasons: string[] = []
  const httpStatuses: number[] = []
  const stopReasons: string[] = []
  const message = record(observation.message)
  const upstream = record(observation.upstream)
  let failed = inspectRecord(message, codes, finishReasons, httpStatuses)
  failed = inspectRecord(upstream, codes, finishReasons, httpStatuses) || failed

  for (const source of [message, upstream]) {
    const stopReason = stringField(source, "stopReason")
    if (stopReason) stopReasons.push(stopReason)
    const status = stringField(source, "status")
    if (status === "error" || status === "failed") failed = true

    const diagnostics = Array.isArray(source?.diagnostics) ? source.diagnostics : []
    for (const item of diagnostics) {
      const diagnostic = record(item)
      failed = inspectRecord(diagnostic, codes, finishReasons, httpStatuses) || failed
      const details = record(diagnostic?.details)
      failed = inspectRecord(details, codes, finishReasons, httpStatuses) || failed
    }
  }

  if (codes.length > 0 || httpStatuses.some((status) => status >= 400)) failed = true
  if (stopReasons.some((reason) => reason === "aborted" || reason === "error")) failed = true
  if (finishReasons.some((reason) => !NORMAL_FINISH_REASONS.has(reason))) failed = true

  return {
    codes: [...new Set(codes)],
    finishReasons: [...new Set(finishReasons)],
    httpStatuses: [...new Set(httpStatuses)],
    stopReasons: [...new Set(stopReasons)],
    failed,
  }
}

function isZaiRoute(observation: FailureObservation): boolean {
  const provider = observation.provider.toLowerCase()
  const model = observation.model?.toLowerCase()
  return (
    observation.adapter === "zai" ||
    observation.adapter === "zai-openai-completions" ||
    provider === "zai" ||
    provider === "zai-coding-cn" ||
    provider.startsWith("glm-") ||
    model?.startsWith("glm-") === true
  )
}

function securityPolicyBlock(
  observation: FailureObservation,
  structured: StructuredEvidence,
): SecurityPolicyBlock | undefined {
  const codexRoute = observation.adapter === "openai-codex" || observation.provider === "openai-codex"
  if (codexRoute && structured.codes.includes("cyberPolicy")) {
    return {
      kind: "security_policy_block",
      providerCode: "cyberPolicy",
      evidence: "codex_error_code",
      retryable: false,
    }
  }

  const openAIProtocol =
    observation.adapter === "openai-codex" ||
    observation.adapter === "openai-completions" ||
    observation.adapter === "openai-responses"
  if (openAIProtocol && structured.finishReasons.includes("content_filter")) {
    return {
      kind: "security_policy_block",
      providerCode: "content_filter",
      evidence: "openai_finish_reason",
      retryable: false,
    }
  }

  if (isZaiRoute(observation) && structured.finishReasons.includes("sensitive")) {
    return {
      kind: "security_policy_block",
      providerCode: "sensitive",
      evidence: "glm_finish_reason",
      retryable: false,
    }
  }
}

function ordinaryFailure(structured: StructuredEvidence): OrdinaryFailure | undefined {
  if (!structured.failed) return
  if (structured.stopReasons.includes("aborted"))
    return { kind: "cancelled", providerCode: "aborted", retryable: false }

  const providerCode = structured.codes[0]
  const httpStatus = structured.httpStatuses.find((status) => status >= 400)
  const common = {
    ...(providerCode ? { providerCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }

  if (providerCode && AUTHENTICATION_CODES.has(providerCode))
    return { kind: "authentication", ...common, retryable: false }
  if (httpStatus === 401 || httpStatus === 403) return { kind: "authentication", ...common, retryable: false }
  if (providerCode && RATE_LIMIT_CODES.has(providerCode)) return { kind: "rate_limit", ...common, retryable: true }
  if (httpStatus === 429) return { kind: "rate_limit", ...common, retryable: true }
  if (providerCode && CAPACITY_CODES.has(providerCode)) return { kind: "capacity", ...common, retryable: false }
  if (providerCode && TIMEOUT_CODES.has(providerCode)) return { kind: "timeout", ...common, retryable: true }
  if (httpStatus === 408 || httpStatus === 504) return { kind: "timeout", ...common, retryable: true }
  if (providerCode && NETWORK_CODES.has(providerCode)) return { kind: "network", ...common, retryable: true }
  if (providerCode && UNAVAILABLE_CODES.has(providerCode)) return { kind: "unavailable", ...common, retryable: true }
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503)
    return { kind: "unavailable", ...common, retryable: true }
  if (providerCode && MALFORMED_OUTPUT_CODES.has(providerCode))
    return { kind: "malformed_output", ...common, retryable: false }
  return { kind: "unknown", ...common, retryable: false }
}

export function classify(observation: FailureObservation): Failure | undefined {
  const structured = evidence(observation)
  if (structured.stopReasons.includes("aborted"))
    return { kind: "cancelled", providerCode: "aborted", retryable: false }
  return securityPolicyBlock(observation, structured) ?? ordinaryFailure(structured)
}

export function isSecurityPolicyBlock(failure: Failure | undefined): failure is SecurityPolicyBlock {
  return failure?.kind === "security_policy_block"
}

export * as PiSecurity from "./pi-security"
