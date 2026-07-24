// ── Subsystem Readiness Snapshot ────────────────────────────────
// Probes the configured Codex runtime and authentication state in parallel,
// then reduces failures into a public status safe for the TUI.
// → cyberful/src/server/routes/instance/httpapi/handlers/instance.ts — exposes the snapshot.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────

import { codexLoggedIn, codexVersionStatus, type CodexVersionStatus } from "@/dependency/codex"
import { DependencyConfig, type ExpertRuntime } from "@/dependency/config"

export type PrimaryAvailability = "available" | "degraded" | "unavailable"

export type Readiness = {
  primary: {
    name: string
    model: string
    version?: string
    status: PrimaryAvailability
  }
}

interface InspectOptions {
  readonly runtime?: ExpertRuntime
  readonly inspectVersion?: () => Promise<CodexVersionStatus>
  readonly inspectLogin?: () => Promise<boolean>
}

// ── Readiness Checks Never Acquire Runtime Ownership ─────────────
// The home screen needs current reachability without starting a phase or keeping
// a daemon alive. Independent bounded probes run concurrently and their failures
// become unavailable states, allowing the rest of the control plane to remain
// usable. The actual phase setup still owns strict runtime configuration and
// starts no process as part of this welcome-screen check.
// ─────────────────────────────────────────────────────────────────
export async function inspect(options: InspectOptions = {}): Promise<Readiness> {
  const runtime = options.runtime ?? DependencyConfig.expertRuntime()
  const [versionResult, loginResult] = await Promise.allSettled([
    (options.inspectVersion ?? (() => codexVersionStatus({ executable: runtime.command })))(),
    (options.inspectLogin ?? (() => codexLoggedIn({ executable: runtime.command })))(),
  ])

  const primary = (() => {
    const version = versionResult.status === "fulfilled" ? versionResult.value : undefined
    const authenticated = loginResult.status === "fulfilled" && loginResult.value
    const status: PrimaryAvailability =
      !version || version.status === "absent" || !authenticated
        ? "unavailable"
        : version.status === "mismatch"
          ? "degraded"
          : "available"
    return {
      name: runtime.backend,
      model: runtime.model ?? runtime.backend,
      ...(version?.version ? { version: version.version } : {}),
      status,
    }
  })()

  return { primary }
}

export * as SubsystemStatus from "./status"
