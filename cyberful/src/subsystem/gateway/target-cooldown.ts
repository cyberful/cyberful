// ── Authorized Target Transport Cooldown ───────────────────────
// Exposes one narrowly gated cooperative pause when an authorized origin that
//   was responsive abruptly stops producing any HTTP response.
// → cyberful/src/subsystem/gateway/server.ts — gates every phase tool request.
// → cyberful/src/subsystem/phase-budget-clock.ts — excludes the pause from active time.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { EngagementPolicy } from "./engagement-policy"
import type { GatewayToolDefinition } from "./tool-registry"

export const TARGET_COOLDOWN_TOOL_NAME = "target_cooldown"
export const TARGET_COOLDOWN_DEFAULT_SECONDS = 180
export const TARGET_COOLDOWN_MAX_SECONDS = 360

const TRANSPORT_ERRORS = ["empty_response", "connection_reset", "connection_timeout"] as const
type TransportError = (typeof TRANSPORT_ERRORS)[number]

type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>

interface ActiveCooldown {
  readonly origin: string
  readonly resumed: Promise<void>
  readonly release: () => void
}

export interface TargetCooldownResult {
  readonly ok: true
  readonly origin: string
  readonly duration_seconds: number
  readonly transport_error: TransportError
  readonly consecutive_transport_failures: number
  readonly started_at: string
  readonly resumed_at: string
  readonly output: string
}

export const TARGET_COOLDOWN_TOOL_DEF: GatewayToolDefinition = {
  name: TARGET_COOLDOWN_TOOL_NAME,
  description:
    "Pause every new tool execution in this phase after the same authorized origin was previously responsive and then produced at least two consecutive transport failures with no HTTP status. Use only for sudden empty responses, connection resets, or connection timeouts; never for HTTP 4xx/5xx, rate-limit responses, CAPTCHA, generic slowness, provider/tool errors, or local proxy/gateway failure. Default 180 seconds, caller-expandable to 360 seconds. At most one cooldown per origin per phase; after it completes, perform at most one bounded health check and defer the origin if it still does not respond.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      origin: {
        type: "string",
        description: "Exact HTTP(S) origin that was responsive before the repeated transport failures.",
      },
      duration_seconds: {
        type: "integer",
        minimum: TARGET_COOLDOWN_DEFAULT_SECONDS,
        maximum: TARGET_COOLDOWN_MAX_SECONDS,
        default: TARGET_COOLDOWN_DEFAULT_SECONDS,
        description: "Cooldown duration. Omit for 180 seconds; may be expanded up to 360 seconds.",
      },
      previously_responsive: {
        type: "boolean",
        const: true,
        description: "Attest that this origin returned an HTTP response earlier in the current phase.",
      },
      consecutive_transport_failures: {
        type: "integer",
        minimum: 2,
        maximum: 10,
        description: "Consecutive failures from this origin that returned no HTTP status.",
      },
      transport_error: {
        type: "string",
        enum: [...TRANSPORT_ERRORS],
        description: "Observed transport-level failure class; HTTP response statuses are ineligible.",
      },
      evidence_summary: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Brief evidence that the origin was responsive and then failed repeatedly without HTTP status.",
      },
    },
    required: [
      "origin",
      "previously_responsive",
      "consecutive_transport_failures",
      "transport_error",
      "evidence_summary",
    ],
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("target cooldown was cancelled")
  error.name = "AbortError"
  return error
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const timer = setTimeout(done, delayMs)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(abortError(signal))
    }
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      () => {
        signal.removeEventListener("abort", abort)
        resolve()
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function normalizedOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000)
    throw new Error("origin must be an exact HTTP(S) origin")
  const parsed = new URL(value.trim())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("origin must use HTTP(S)")
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/")
    throw new Error("origin must not contain credentials, a path, query parameters, or a fragment")
  return parsed.origin
}

function authorizedHost(hostname: string, patterns: readonly string[]) {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase()
    return normalized.startsWith("*.")
      ? host.endsWith(`.${normalized.slice(2)}`) && host !== normalized.slice(2)
      : host === normalized
  })
}

function durationSeconds(value: unknown) {
  if (value === undefined) return TARGET_COOLDOWN_DEFAULT_SECONDS
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < TARGET_COOLDOWN_DEFAULT_SECONDS ||
    value > TARGET_COOLDOWN_MAX_SECONDS
  )
    throw new Error("duration_seconds must be an integer between 180 and 360")
  return value
}

function transportError(value: unknown): TransportError {
  if (typeof value !== "string" || !TRANSPORT_ERRORS.includes(value as TransportError))
    throw new Error("transport_error must be empty_response, connection_reset, or connection_timeout")
  return value as TransportError
}

// ── One Phase-Wide Cooperative Barrier ─────────────────────────
// The cooldown request installs its barrier synchronously before sleeping, so
// every later gateway request observes it. Calls already dispatched are not
// cancelled: they reach their natural boundary, and only their next tool call
// waits. Shutdown aborts the timer and releases all waiters without destroying
// any AgentRun. A used origin remains used even if the request is cancelled,
// preventing repeated timers from becoming a retry strategy.
// ─────────────────────────────────────────────────────────────────
export class TargetCooldownController {
  readonly #sleep: Sleep
  readonly #now: () => number
  readonly #lifecycle = new AbortController()
  readonly #usedOrigins = new Set<string>()
  #active: ActiveCooldown | undefined

  constructor(options: { sleep?: Sleep; now?: () => number } = {}) {
    this.#sleep = options.sleep ?? sleep
    this.#now = options.now ?? Date.now
  }

  async wait(signal: AbortSignal): Promise<void> {
    const active = this.#active
    if (!active) return
    await waitFor(active.resumed, signal)
  }

  async run(
    input: unknown,
    policy: EngagementPolicy | undefined,
    signal: AbortSignal,
  ): Promise<TargetCooldownResult> {
    if (!isRecord(input)) throw new Error("target_cooldown input must be an object")
    const origin = normalizedOrigin(input.origin)
    const parsed = new URL(origin)
    if (!policy || !authorizedHost(parsed.hostname, policy.authorized_http_hosts))
      throw new Error("origin is not authorized by the engagement policy")
    if (input.previously_responsive !== true)
      throw new Error("previously_responsive must be true")
    if (
      typeof input.consecutive_transport_failures !== "number" ||
      !Number.isInteger(input.consecutive_transport_failures) ||
      input.consecutive_transport_failures < 2 ||
      input.consecutive_transport_failures > 10
    )
      throw new Error("consecutive_transport_failures must be an integer between 2 and 10")
    if (typeof input.evidence_summary !== "string" || !input.evidence_summary.trim() || input.evidence_summary.length > 500)
      throw new Error("evidence_summary must contain between 1 and 500 characters")
    const duration = durationSeconds(input.duration_seconds)
    const error = transportError(input.transport_error)
    if (this.#lifecycle.signal.aborted) throw abortError(this.#lifecycle.signal)
    if (this.#active) throw new Error(`a target cooldown is already active for ${this.#active.origin}`)
    if (this.#usedOrigins.has(origin)) throw new Error("this origin already used its one cooldown for the phase")

    let release = () => {}
    const resumed = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = { origin, resumed, release }
    this.#usedOrigins.add(origin)
    this.#active = active
    const startedAt = this.#now()
    try {
      await this.#sleep(duration * 1_000, AbortSignal.any([signal, this.#lifecycle.signal]))
    } finally {
      active.release()
      if (this.#active === active) this.#active = undefined
    }
    const resumedAt = this.#now()
    return {
      ok: true,
      origin,
      duration_seconds: duration,
      transport_error: error,
      consecutive_transport_failures: input.consecutive_transport_failures,
      started_at: new Date(startedAt).toISOString(),
      resumed_at: new Date(resumedAt).toISOString(),
      output:
        "Cooldown complete. Perform at most one bounded health check. If the origin still returns no HTTP response, defer it for this phase without starting another cooldown.",
    }
  }

  close() {
    if (!this.#lifecycle.signal.aborted)
      this.#lifecycle.abort(new Error("phase gateway closed during target cooldown"))
    this.#active?.release()
    this.#active = undefined
  }
}
