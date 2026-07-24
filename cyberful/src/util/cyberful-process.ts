// ── Cyberful Process Identity ────────────────────────────────────
// Validates and propagates one run identity and process role across the main
// process, workers, and runtime health responses. Model subprocesses receive a
// deliberately reduced environment so nested Cyberful commands cannot inherit
// the host run's cleanup authority.
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

// ── Model Children Cannot Own The Host Run ───────────────────────
// Run identity authorizes process and container cleanup, so it must stop at the
// host-to-model boundary. A model shell may legitimately invoke `cyberful
// --version`; inheriting the parent identity would let that nested CLI finalize
// the active run. Strip ownership after process overrides are merged, while
// the private gateway file carries the same identity to trusted host tooling.
// ─────────────────────────────────────────────────────────────────
export function sanitizedModelProcessEnv(overrides?: Record<string, string>) {
  const env = sanitizedProcessEnv(overrides)
  delete env[CYBERFUL_RUN_ID]
  delete env[CYBERFUL_PROCESS_ROLE]
  return env
}
