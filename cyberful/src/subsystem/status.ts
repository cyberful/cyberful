// ── Pi Subsystem Readiness Snapshot ─────────────────────────────
// Loads the provider routes owned by settings.yaml, runs Pi's authentication
//   preflight, and reduces the result into the bounded public TUI status.
// → cyberful/src/server/routes/instance/httpapi/handlers/instance.ts — exposes the snapshot.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────

import piAgentPackage from "@earendil-works/pi-agent-core/package.json"
import { Settings } from "@/config/settings"
import type { SubsystemStatus as AgentSubsystemStatus } from "./agent-subsystem"
import { PiAgentSubsystem } from "./pi-agent"
import { PiCredentialStore } from "./pi-credentials"
import { createPiModels } from "./pi-models"

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
  readonly settings?: Settings.Info
  readonly loadSettings?: () => Promise<Settings.Info>
  readonly inspectSubsystem?: (settings: Settings.Info) => Promise<AgentSubsystemStatus>
}

// ── Readiness Checks Never Acquire Runtime Ownership ─────────────
// The home screen may validate configuration and credentials, but must not
// retain a phase owner or start an AgentRun. The temporary subsystem owns no
// gateway and is shut down after authentication inspection. Failures become a
// public unavailable state so malformed settings cannot break the home screen,
// while the launch preflight can still surface the detailed provider errors.
// ─────────────────────────────────────────────────────────────────
export async function preflight(
  settings: Settings.Info,
  inspectSubsystem?: InspectOptions["inspectSubsystem"],
): Promise<AgentSubsystemStatus> {
  if (inspectSubsystem) return inspectSubsystem(settings)

  const registry = createPiModels(settings.agent, new PiCredentialStore())
  const subsystem = new PiAgentSubsystem({ settings, registry })
  try {
    return await subsystem.preflight(settings)
  } finally {
    await subsystem.shutdown()
  }
}

export async function inspect(options: InspectOptions = {}): Promise<Readiness> {
  let settings: Settings.Info
  try {
    settings = options.settings ?? (await (options.loadSettings ?? (() => Settings.load()))())
  } catch {
    return {
      primary: {
        name: "pi",
        model: "unconfigured",
        version: piAgentPackage.version,
        status: "unavailable",
      },
    }
  }

  const providerID = settings.agent.primary_provider
  const configuredModel = settings.agent.providers[providerID]?.model ?? "unconfigured"
  try {
    const result = await preflight(settings, options.inspectSubsystem)
    const primary = result.providers.find((provider) => provider.route === "primary")
    const status: PrimaryAvailability = !result.ready || !primary?.authenticated
      ? "unavailable"
      : result.degraded
        ? "degraded"
        : "available"
    return {
      primary: {
        name: `pi/${providerID}`,
        model: primary?.model ?? configuredModel,
        version: piAgentPackage.version,
        status,
      },
    }
  } catch {
    return {
      primary: {
        name: `pi/${providerID}`,
        model: configuredModel,
        version: piAgentPackage.version,
        status: "unavailable",
      },
    }
  }
}

export * as SubsystemStatus from "./status"
