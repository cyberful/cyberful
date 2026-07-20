// ── Subsystem Readiness Snapshot ────────────────────────────────
// Probes the configured primary subsystem and optional local fallback in
//   parallel, then reduces failures into a public status safe for the TUI.
// → cyberful/src/subsystem/fallback.ts — validates and probes fallback configuration.
// → cyberful/src/server/routes/instance/httpapi/handlers/instance.ts — exposes the snapshot.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────

import { codexLoggedIn, codexVersionStatus, type CodexVersionStatus } from "@/dependency/codex"
import { DependencyConfig, type ExpertRuntime } from "@/dependency/config"
import { SubsystemFallback, type Resolution as FallbackResolution } from "@/subsystem/fallback"

export type PrimaryAvailability = "available" | "degraded" | "unavailable"
export type FallbackAvailability = "available" | "disabled" | "unavailable"

export type Readiness = {
  primary: {
    name: string
    model: string
    version?: string
    status: PrimaryAvailability
  }
  fallback: {
    model?: string
    status: FallbackAvailability
  }
}

interface InspectOptions {
  readonly runtime?: ExpertRuntime
  readonly inspectVersion?: () => Promise<CodexVersionStatus>
  readonly inspectLogin?: () => Promise<boolean>
  readonly inspectFallback?: () => Promise<FallbackResolution>
}

// ── Readiness Checks Never Acquire Runtime Ownership ─────────────
// The home screen needs current reachability without starting a phase or keeping
// a daemon alive. Independent bounded probes run concurrently and their failures
// become unavailable states, allowing the rest of the control plane to remain
// usable. The actual phase setup still owns strict configuration validation and
// repeats its authoritative fallback preflight at the engagement boundary.
// ─────────────────────────────────────────────────────────────────
export async function inspect(directory: string, options: InspectOptions = {}): Promise<Readiness> {
  const runtime = options.runtime ?? DependencyConfig.expertRuntime()
  const [versionResult, loginResult, fallbackResult] = await Promise.allSettled([
    (options.inspectVersion ?? (() => codexVersionStatus({ executable: runtime.command })))(),
    (options.inspectLogin ?? (() => codexLoggedIn({ executable: runtime.command })))(),
    (options.inspectFallback ?? (() => SubsystemFallback.load(directory)))(),
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

  if (fallbackResult.status === "rejected") {
    return { primary, fallback: { status: "unavailable" } }
  }
  if (fallbackResult.value.status === "disabled") {
    return { primary, fallback: { status: "disabled" } }
  }
  return {
    primary,
    fallback: {
      model: fallbackResult.value.config.model,
      status: fallbackResult.value.status,
    },
  }
}

export * as SubsystemStatus from "./status"
