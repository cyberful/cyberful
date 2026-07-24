// ── Docker Resource Ownership Identity ──────────────────────────
// Derives non-reversible run ownership and the common labels used by every
//   Cyberful-managed container so shutdown and startup recovery share one key.
// → cyberful/src/subsystem/container.ts — sweeps resources by run ownership.
// → cyberful/src/dependency/docker-preflight.ts — reaps resources whose owner PID died.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"

export const MANAGED_LABEL = "org.cyberful.managed"
export const OWNER_PID_LABEL = "org.cyberful.owner-pid"
export const RUN_OWNER_LABEL = "org.cyberful.run-owner"
export const RUNTIME_LABEL = "org.cyberful.runtime"
export const SESSION_LABEL = "org.cyberful.session"

export function runOwnerToken(runID = process.env.CYBERFUL_RUN_ID?.trim()): string | undefined {
  if (!runID) return
  return createHash("sha256").update(runID).digest("hex")
}

export function dockerOwnershipLabels(input: {
  managed: string
  runtime: string
  session: string
  ownerPID?: number
  runID?: string
}): string[] {
  const ownerPID = input.ownerPID ?? process.pid
  const runOwner = runOwnerToken(input.runID) ?? "unowned"
  return [
    `${MANAGED_LABEL}=${input.managed}`,
    `${OWNER_PID_LABEL}=${ownerPID}`,
    `${SESSION_LABEL}=${input.session}`,
    `${RUNTIME_LABEL}=${input.runtime}`,
    `${RUN_OWNER_LABEL}=${runOwner}`,
  ]
}
