// ── Pi Phase Runtime Boundary ────────────────────────────────────
// Preserves the host's buffered/streaming lifecycle surface while delegating
// execution to an in-process, phase-scoped Pi worker owner rather than a model CLI.
// → cyberful/src/subsystem/pi-phase-runtime.ts — owns complete AgentRuns.
// ─────────────────────────────────────────────────────────────────

import type { AgentEvent } from "./agent-subsystem"
import {
  SubsystemPiPhaseRuntime,
  type RunInput,
  type RunResult,
  type RunTermination,
} from "./pi-phase-runtime"

const PROCESS_TREE_CLEANUP_TIMEOUT_MS = 5_000
const PROCESS_TREE_CLEANUP_OUTPUT_BYTES = 64 * 1024
let liveListener: ((pids: number[]) => void) | undefined

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

export function onLiveChange(listener: (pids: number[]) => void): void {
  liveListener = listener
  liveListener([])
}

export function livePids(): number[] {
  return []
}

export function liveCount(): number {
  return SubsystemPiPhaseRuntime.activeCount()
}

// Gateway emergency reaping still uses process groups registered by the
// gateway itself. Normal Pi completion closes the MCP transport first.
export function killTree(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) return
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        timeout: PROCESS_TREE_CLEANUP_TIMEOUT_MS,
        maxBuffer: PROCESS_TREE_CLEANUP_OUTPUT_BYTES,
      })
    } else {
      process.kill(-pid, signal)
    }
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error
  }
}

export async function killAll(): Promise<void> {
  await SubsystemPiPhaseRuntime.shutdownAll()
  liveListener?.([])
}

export function resetForTests(): void {}

export function run(input: RunInput): Promise<RunResult> {
  return SubsystemPiPhaseRuntime.run(input)
}

export function runStreaming(input: RunInput, onEvent: (event: AgentEvent) => void): Promise<RunResult> {
  return SubsystemPiPhaseRuntime.run(input, onEvent)
}

export type { RunInput, RunResult, RunTermination }

export * as SubsystemCli from "./cli"
