// ── Sanitized Local Runtime Diagnostics ──────────────────────────
// Retains bounded agent, phase, ZAP, browser, gateway, and MCP observations
// without placing raw stderr, request bodies, prompts, or environment data in model context.
// Only actionable severities notify the operator; repeated records are
// summarized once at close.
// → cyberful/src/subsystem/pi-mcp.ts — supplies gateway/MCP observations.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash } from "node:crypto"
import { appendWorkareaFile } from "@/workarea"
import { PiAudit } from "./pi-audit"

export const RUNTIME_DIAGNOSTICS_PATH = "raw/operations/runtime-diagnostics.jsonl"
const RECORD_BYTES = 8 * 1024
const PHASE_BYTES = 256 * 1024
const MESSAGE_BYTES = 512
const LABEL_BYTES = 256

export interface RuntimeDiagnosticInput {
  readonly component: "agent" | "phase" | "gateway" | "zap" | "browser" | "mcp"
  readonly profile?: string
  readonly stage: "startup" | "connect" | "context" | "provider" | "tool" | "shutdown"
  readonly severity: "info" | "warning" | "error"
  readonly errorClass: string
  readonly code?: string
  readonly message: string
  readonly outcome?:
    | "lifecycle_info"
    | "recovered_retry"
    | "tool_failure"
    | "degraded_observability"
    | "context_rotation"
    | "capacity_failure"
    | "recovered_cleanup"
    | "cleanup_failure"
    | "runtime_failure"
  readonly blocking?: boolean
}

export interface RuntimeDiagnosticSummary {
  readonly component: RuntimeDiagnosticInput["component"]
  readonly profile?: string
  readonly stage: RuntimeDiagnosticInput["stage"]
  readonly severity: Exclude<RuntimeDiagnosticInput["severity"], "info">
  readonly errorClass: string
  readonly code?: string
  readonly message: string
  readonly path: typeof RUNTIME_DIAGNOSTICS_PATH
}

type Aggregate = {
  readonly input: RuntimeDiagnosticInput
  readonly message: string
  readonly firstTimestamp: string
  lastTimestamp: string
  count: number
}

function stripUrls(text: string) {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (value) => {
    try {
      const url = new URL(value)
      url.username = ""
      url.password = ""
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]")
      return url.toString()
    } catch {
      return value.replace(/\?.*$/u, "?[REDACTED]")
    }
  })
}

export function sanitizeRuntimeDiagnostic(message: string): string {
  const withoutTerminal = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
  const redacted = stripUrls(PiAudit.redactText(withoutTerminal))
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/\b(api[-_ ]?key|password|passwd|secret|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .trim()
  const bytes = Buffer.from(redacted || "runtime error without a printable message", "utf8")
  return bytes.length <= MESSAGE_BYTES ? bytes.toString("utf8") : bytes.subarray(0, MESSAGE_BYTES).toString("utf8")
}

function diagnosticLabel(value: string): string {
  const sanitized = sanitizeRuntimeDiagnostic(value)
  const bytes = Buffer.from(sanitized, "utf8")
  return bytes.length <= LABEL_BYTES ? sanitized : bytes.subarray(0, LABEL_BYTES).toString("utf8")
}

function diagnosticSignature(input: RuntimeDiagnosticInput): string {
  return [
    input.component,
    input.profile ?? "",
    input.stage,
    input.severity,
    input.errorClass,
    input.code ?? input.errorClass,
  ].join("\0")
}

export class RuntimeDiagnosticRecorder {
  readonly #workarea: string
  readonly #sessionID: string
  readonly #workflow: string
  readonly #phase: string
  readonly #attempt: number
  readonly #onFirst?: (summary: RuntimeDiagnosticSummary) => void
  readonly #records = new Map<string, Aggregate>()
  #queue: Promise<void> = Promise.resolve()
  #writtenBytes = 0

  constructor(input: {
    readonly workarea: string
    readonly sessionID: string
    readonly workflow: string
    readonly phase: string
    readonly attempt: number
    readonly onFirst?: (summary: RuntimeDiagnosticSummary) => void
  }) {
    if (!path.isAbsolute(input.workarea)) throw new Error("runtime diagnostics require an absolute workarea")
    this.#workarea = input.workarea
    this.#sessionID = input.sessionID
    this.#workflow = input.workflow
    this.#phase = input.phase
    this.#attempt = input.attempt
    this.#onFirst = input.onFirst
  }

  record(input: RuntimeDiagnosticInput): void {
    const message = sanitizeRuntimeDiagnostic(input.message)
    const key = diagnosticSignature(input)
    const now = new Date().toISOString()
    const current = this.#records.get(key)
    if (current) {
      current.count++
      current.lastTimestamp = now
      return
    }
    const aggregate: Aggregate = {
      input,
      message,
      firstTimestamp: now,
      lastTimestamp: now,
      count: 1,
    }
    this.#records.set(key, aggregate)
    this.#append(aggregate)
    if (input.severity !== "info")
      this.#onFirst?.({
        component: input.component,
        ...(input.profile ? { profile: diagnosticLabel(input.profile) } : {}),
        stage: input.stage,
        severity: input.severity,
        errorClass: diagnosticLabel(input.errorClass),
        ...(input.code ? { code: diagnosticLabel(input.code) } : {}),
        message: diagnosticLabel(message),
        path: RUNTIME_DIAGNOSTICS_PATH,
      })
  }

  close(): Promise<void> {
    for (const aggregate of this.#records.values()) if (aggregate.count > 1) this.#append(aggregate)
    return this.#queue
  }

  #append(aggregate: Aggregate) {
    const signature = createHash("sha256")
      .update(diagnosticSignature(aggregate.input))
      .digest("hex")
    const row = {
      version: 2,
      timestamp: aggregate.lastTimestamp,
      firstTimestamp: aggregate.firstTimestamp,
      lastTimestamp: aggregate.lastTimestamp,
      sessionID: this.#sessionID,
      workflow: this.#workflow,
      phase: this.#phase,
      attempt: this.#attempt,
      component: aggregate.input.component,
      ...(aggregate.input.profile ? { profile: diagnosticLabel(aggregate.input.profile) } : {}),
      stage: aggregate.input.stage,
      severity: aggregate.input.severity,
      errorClass: diagnosticLabel(aggregate.input.errorClass),
      ...(aggregate.input.code ? { code: diagnosticLabel(aggregate.input.code) } : {}),
      outcome:
        aggregate.input.outcome ??
        (aggregate.input.severity === "info"
          ? "lifecycle_info"
          : aggregate.input.stage === "tool"
            ? "tool_failure"
            : "runtime_failure"),
      blocking: aggregate.input.blocking ?? false,
      signature,
      message: aggregate.message,
      originalBytes: Buffer.byteLength(aggregate.input.message, "utf8"),
      messageSha256: createHash("sha256").update(aggregate.input.message).digest("hex"),
      count: aggregate.count,
    }
    const line = `${JSON.stringify(row)}\n`
    const bytes = Buffer.byteLength(line, "utf8")
    if (bytes > RECORD_BYTES) return
    if (this.#writtenBytes + bytes > PHASE_BYTES) return
    this.#writtenBytes += bytes
    this.#queue = this.#queue.then(() =>
      appendWorkareaFile(this.#workarea, RUNTIME_DIAGNOSTICS_PATH, line, {
        mode: 0o600,
      }).then(() => undefined),
    )
  }
}

export * as SubsystemRuntimeDiagnostics from "./runtime-diagnostics"
