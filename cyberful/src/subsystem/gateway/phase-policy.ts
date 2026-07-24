// ── Gateway Phase Policy ─────────────────────────────────────────
// Resolves workflow capabilities and phase-specific tool ownership once so
// startup, upstream connection, and local tool publication share one policy.
// ─────────────────────────────────────────────────────────────────

import { SubsystemPhase } from "../phase"

export type GatewayPhasePolicy = {
  workflow?: string
  phase?: string
  active: boolean
  liveTargetResearch: boolean
  sourceImport: boolean
  auditDiff: boolean
  auditLab: boolean
  evmLab: boolean
  evmEvidence: boolean
  allows: (capability: SubsystemPhase.WorkflowCapability) => boolean
}

export function runtimeCapabilityAllowed(input: {
  workflow?: string
  phase?: string
  capability: SubsystemPhase.WorkflowCapability
  authorized: boolean
}) {
  if (!input.workflow || !SubsystemPhase.workflow(input.workflow)) return false
  return SubsystemPhase.phaseHasCapability(input.workflow, input.phase, input.capability)
}

export function runtimeNetworkAllowed(input: { workflow?: string; phase?: string; authorized: boolean }) {
  return input.workflow !== "code-audit"
}

export function gatewayPhasePolicy(input?: { workflow?: string; phase?: string }): GatewayPhasePolicy {
  const workflow = input?.workflow ?? process.env.CYBERFUL_SUBSYSTEM_WORKFLOW?.trim()
  const phase = input?.phase ?? process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  const active = Boolean(
    workflow &&
      phase &&
      SubsystemPhase.workflow(workflow) &&
      (SubsystemPhase.isExpertPhase(workflow, phase) || SubsystemPhase.isInteractiveAgent(workflow, phase)),
  )
  const allows = (capability: SubsystemPhase.WorkflowCapability) =>
    active && Boolean(workflow && SubsystemPhase.phaseHasCapability(workflow, phase, capability))
  const liveTargetResearch =
    active &&
    (workflow === "pentest" || workflow === "bug-bounty") &&
    phase !== undefined &&
    ["recon", "exploit", "hacker", "verify"].includes(phase)

  return {
    workflow,
    phase,
    active,
    liveTargetResearch,
    sourceImport:
      active &&
      ((workflow === "code-audit" && phase === "scope") ||
        (workflow === "bug-bounty" && (phase === "brief" || phase === "recon"))),
    auditDiff: active && workflow === "code-audit" && phase === "scope" && allows("audit-diff"),
    auditLab: active && workflow === "code-audit" && (phase === "attack" || phase === "verify"),
    evmLab:
      active &&
      workflow === "bug-bounty" &&
      allows("evm-lab") &&
      phase !== undefined &&
      ["recon", "exploit", "hacker", "verify"].includes(phase),
    evmEvidence:
      active &&
      workflow === "bug-bounty" &&
      allows("evm-lab") &&
      phase !== undefined &&
      ["recon", "exploit", "hacker", "verify", "report"].includes(phase),
    allows,
  }
}
