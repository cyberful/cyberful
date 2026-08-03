// ── Cyberful Process Identity ────────────────────────────────────
// Validates and propagates one run identity and process role across the main
// process, workers, and runtime health responses, plus a complete explicit
// environment for trusted child processes.
// → cyberful/src/server/runtime-identity.ts — publishes this metadata for health checks.
// → cyberful/src/cli/cmd/tui/thread.ts — passes the identity into the TUI worker.
// → cyberful/src/subsystem/gateway/config.ts — retains ownership in the private gateway environment.
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { InstallationBuildID } from "../installation/version"

export const CYBERFUL_RUN_ID = "CYBERFUL_RUN_ID"
export const CYBERFUL_PROCESS_ROLE = "CYBERFUL_PROCESS_ROLE"
const startedAt = Math.floor(Date.now() - process.uptime() * 1_000)

export function ensureRunID() {
  const configured = process.env[CYBERFUL_RUN_ID]?.trim()
  const runID = configured || randomUUID()
  process.env[CYBERFUL_RUN_ID] = runID
  return runID
}

export function ensureProcessRole(fallback: "main" | "worker") {
  const configured = process.env[CYBERFUL_PROCESS_ROLE]?.trim()
  const role = configured === "main" || configured === "worker" ? configured : fallback
  process.env[CYBERFUL_PROCESS_ROLE] = role
  return role
}

export function ensureProcessMetadata(fallback: "main" | "worker") {
  return {
    buildID: InstallationBuildID,
    runID: ensureRunID(),
    processRole: ensureProcessRole(fallback),
    pid: process.pid,
    startedAt,
  }
}

export function sanitizedProcessEnv(overrides?: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return overrides ? Object.assign(env, overrides) : env
}
