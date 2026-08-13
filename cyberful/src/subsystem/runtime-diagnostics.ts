// ── Sanitized Local Runtime Diagnostics ──────────────────────────
// Retains bounded agent, phase, ZAP, browser, gateway, and MCP observations
// without placing raw stderr, request bodies, prompts, or environment data in model context.
// Only actionable severities notify the operator; every raw event is immutable
// and repeated signatures are summarized only by downstream readers.
// → cyberful/src/subsystem/pi-mcp.ts — supplies gateway/MCP observations.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { appendWorkareaFile } from "@/workarea"
import { PiAudit } from "./pi-audit"
import type { AgentRunID, AgentRunRole, AgentRunTermination, AgentRunTerminationCause } from "./agent-subsystem"

export const RUNTIME_DIAGNOSTICS_PATH = "raw/operations/runtime-diagnostics.jsonl"
const RECORD_BYTES = 8 * 1024
const PHASE_BYTES = 256 * 1024
const MESSAGE_BYTES = 512
const LABEL_BYTES = 256

export interface RuntimeDiagnosticInput {
  readonly component: "agent" | "phase" | "gateway" | "cyberful-os" | "zap" | "ghidra" | "browser" | "mcp"
  readonly runID?: AgentRunID
  readonly parentRunID?: AgentRunID
  readonly role?: AgentRunRole
  readonly callID?: string
  readonly server?: string
  readonly route?: string
  readonly termination?: AgentRunTermination
  readonly terminationCause?: AgentRunTerminationCause
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
  readonly runID?: AgentRunID
  readonly parentRunID?: AgentRunID
  readonly role?: AgentRunRole
  readonly callID?: string
  readonly server?: string
  readonly route?: string
  readonly termination?: AgentRunTermination
  readonly terminationCause?: AgentRunTerminationCause
  readonly profile?: string
  readonly stage: RuntimeDiagnosticInput["stage"]
  readonly severity: Exclude<RuntimeDiagnosticInput["severity"], "info">
  readonly errorClass: string
  readonly code?: string
  readonly message: string
  readonly path: typeof RUNTIME_DIAGNOSTICS_PATH
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
    input.runID ?? "",
    input.parentRunID ?? "",
    input.role ?? "",
    input.callID ?? "",
    input.server ?? "",
    input.route ?? "",
    input.termination ?? "",
    input.terminationCause ?? "",
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
  readonly #notified = new Set<string>()
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
    this.#append(input, message, now)
    if (input.severity !== "info" && !this.#notified.has(key)) {
      this.#notified.add(key)
      this.#onFirst?.({
        component: input.component,
        ...(input.runID ? { runID: diagnosticLabel(input.runID) } : {}),
        ...(input.parentRunID ? { parentRunID: diagnosticLabel(input.parentRunID) } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.callID ? { callID: diagnosticLabel(input.callID) } : {}),
        ...(input.server ? { server: diagnosticLabel(input.server) } : {}),
        ...(input.route ? { route: diagnosticLabel(input.route) } : {}),
        ...(input.termination ? { termination: input.termination } : {}),
        ...(input.terminationCause ? { terminationCause: input.terminationCause } : {}),
        ...(input.profile ? { profile: diagnosticLabel(input.profile) } : {}),
        stage: input.stage,
        severity: input.severity,
        errorClass: diagnosticLabel(input.errorClass),
        ...(input.code ? { code: diagnosticLabel(input.code) } : {}),
        message: diagnosticLabel(message),
        path: RUNTIME_DIAGNOSTICS_PATH,
      })
    }
  }

  close(): Promise<void> {
    return this.#queue
  }

  #append(input: RuntimeDiagnosticInput, message: string, timestamp: string) {
    const signature = createHash("sha256")
      .update(diagnosticSignature(input))
      .digest("hex")
    const row = {
      version: 3,
      eventID: randomUUID(),
      timestamp,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp,
      sessionID: this.#sessionID,
      workflow: this.#workflow,
      phase: this.#phase,
      attempt: this.#attempt,
      component: input.component,
      ...(input.runID ? { runID: diagnosticLabel(input.runID) } : {}),
      ...(input.parentRunID ? { parentRunID: diagnosticLabel(input.parentRunID) } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.callID ? { callID: diagnosticLabel(input.callID) } : {}),
      ...(input.server ? { server: diagnosticLabel(input.server) } : {}),
      ...(input.route ? { route: diagnosticLabel(input.route) } : {}),
      ...(input.termination ? { termination: input.termination } : {}),
      ...(input.terminationCause ? { terminationCause: input.terminationCause } : {}),
      ...(input.profile ? { profile: diagnosticLabel(input.profile) } : {}),
      stage: input.stage,
      severity: input.severity,
      errorClass: diagnosticLabel(input.errorClass),
      ...(input.code ? { code: diagnosticLabel(input.code) } : {}),
      outcome:
        input.outcome ??
        (input.severity === "info"
          ? "lifecycle_info"
          : input.stage === "tool"
            ? "tool_failure"
            : "runtime_failure"),
      blocking: input.blocking ?? false,
      signature,
      message,
      originalBytes: Buffer.byteLength(input.message, "utf8"),
      messageSha256: createHash("sha256").update(input.message).digest("hex"),
      count: 1,
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
