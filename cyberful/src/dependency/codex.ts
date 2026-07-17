// ── Codex CLI Compatibility Probe ────────────────────────────────
// Detects the installed Codex CLI, authentication state, and exact version
// compatibility required by Cyberful's app-server protocol integration.
// → cyberful/src/subsystem/codex.ts — enforces these probes before phase execution.
// → cyberful/src/subsystem/codex-compat.integration.test.ts — proves the pinned protocol surface.
// ─────────────────────────────────────────────────────────────────

import { Process } from "@/util/process"

// ── Exact Version Pin Protects The App-Server Contract ───────────
// Cyberful drives a version-sensitive JSON-RPC surface and supplies strict
// configuration keys that an incompatible CLI rejects before a model turn.
// The pin is therefore a protocol compatibility boundary, not a preference.
// It may move only with the integration proof that exercises configuration
// validation and an MCP round trip without requiring a Codex account.
// ─────────────────────────────────────────────────────────────────
export const CODEX_PINNED_VERSION = "0.144.5"

// `codex --version` prints exactly `codex-cli <semver>`.
const VERSION_RE = /^\s*codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/
const PROBE_TIMEOUT_MS = 10_000
const PROBE_KILL_GRACE_MS = 500
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024

export interface CodexProbeOptions {
  readonly executable?: string
  readonly prefixArguments?: readonly string[]
  readonly timeoutMs?: number
}

export function codexInstallCommand(platform: NodeJS.Platform = process.platform): string {
  const npm = `npm install -g @openai/codex@${CODEX_PINNED_VERSION}`
  if (platform === "darwin") return `brew install codex   (or: ${npm})`
  return npm
}

type CaptureResult = { status: "absent" } | { status: "completed"; code: number; stdout: Buffer; stderr: Buffer }

function hasErrorCode(error: unknown, code: string): boolean {
  if (error instanceof AggregateError) return error.errors.some((item) => hasErrorCode(item, code))
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === code) return true
  return "cause" in error && hasErrorCode(error.cause, code)
}

function probeCommand(args: readonly string[], options?: CodexProbeOptions) {
  const executable = options?.executable?.trim() || "codex"
  return [executable, ...(options?.prefixArguments ?? []), ...args]
}

function probeTimeout(options?: CodexProbeOptions) {
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Codex probe timeout must be a positive safe integer")
  }
  return timeoutMs
}

// ── Every Probe Has A Bounded Process Lifetime ──────────────────
// Codex discovery runs before the TUI can offer cancellation, so each command
// owns a fixed deadline and a small output budget. Deadline cancellation sends
// TERM, escalates to KILL, drains both pipes, and observes exit before returning.
// Only a proven missing executable becomes `absent`; permission, timeout, and
// capture failures retain their cause and stop startup with an actionable error.
// ─────────────────────────────────────────────────────────────────
async function capture(args: readonly string[], options?: CodexProbeOptions): Promise<CaptureResult> {
  const command = probeCommand(args, options)
  const timeoutMs = probeTimeout(options)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Codex probe timed out after ${timeoutMs}ms`)), timeoutMs)
  timeout.unref()
  try {
    const result = await Process.run(command, {
      abort: controller.signal,
      env: process.env,
      maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
      timeout: PROBE_KILL_GRACE_MS,
    })
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw reason instanceof Error ? reason : new Error("Codex probe timed out")
    }
    return { status: "completed", ...result }
  } catch (cause) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw new Error(reason instanceof Error ? reason.message : "Codex probe timed out", { cause })
    }
    if (cause instanceof Process.RunFailedError) {
      return { status: "completed", code: cause.code, stdout: cause.stdout, stderr: cause.stderr }
    }
    if (hasErrorCode(cause, "ENOENT")) return { status: "absent" }
    throw new Error(`Failed to execute Codex probe: ${command.join(" ")}`, { cause })
  } finally {
    clearTimeout(timeout)
  }
}

// The installed Codex version, or null only when Codex is not on PATH.
export async function codexVersion(options?: CodexProbeOptions): Promise<string | null> {
  const result = await capture(["--version"], options)
  if (result.status === "absent") return null
  if (result.code !== 0) {
    throw new Process.RunFailedError(probeCommand(["--version"], options), result.code, result.stdout, result.stderr)
  }
  const output = result.stdout.toString("utf8")
  const version = VERSION_RE.exec(output)?.[1]
  if (version) return version
  throw new Error("Codex version output did not match `codex-cli <semver>`", {
    cause: new Error(output.trim() ? `Received: ${output.trim()}` : "Codex returned empty version output"),
  })
}

export type CodexVersionStatus =
  | { status: "match"; version: string }
  | { status: "mismatch"; version: string }
  | { status: "absent"; version: null }

// Resolve presence + exact-pin match in one probe.
export async function codexVersionStatus(options?: CodexProbeOptions): Promise<CodexVersionStatus> {
  const version = await codexVersion(options)
  if (version === null) return { status: "absent", version: null }
  return version === CODEX_PINNED_VERSION ? { status: "match", version } : { status: "mismatch", version }
}

// `codex login status` exits 0 when authenticated (ChatGPT login or API key). We only read the exit code;
// the actual credentials/mechanism are Codex's concern.
export async function codexLoggedIn(options?: CodexProbeOptions): Promise<boolean> {
  const result = await capture(["login", "status"], options)
  return result.status === "completed" && result.code === 0
}

export * as Codex from "./codex"
