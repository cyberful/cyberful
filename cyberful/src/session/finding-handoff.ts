// ── Finding Handoff Reconciliation ──────────────────────────────
// Compares the phase handoff inventory with the durable finding registry before
//   allowing an engagement to advance.
// ─────────────────────────────────────────────────────────────────

import { FindingRegistry } from "@/finding/registry"
import { SubsystemVerdict } from "@/subsystem/verdict"

export function findingWorkflow(value: string): FindingRegistry.Workflow {
  if (value === "pentest" || value === "bug-bounty" || value === "code-audit") return value
  throw new Error(`Workflow '${value}' does not own a finding registry`)
}

export async function findingHandoffWarning(
  store: FindingRegistry.Store,
  input: {
    runID: string
    workflow: FindingRegistry.Workflow
    phase: string
    verdicts?: SubsystemVerdict.Ledger
  },
) {
  const current = (await store.list(input.runID)).filter((item) => item.currentRun !== undefined)
  if (input.phase === "verify") {
    const pending = current.filter((item) => {
      const observation = item.currentRun
      if (!observation || observation.review !== "ASSESSED") return true
      if (observation.verification.result === "NOT_REVIEWED") return true
      return input.workflow === "bug-bounty" && observation.submission.result === "NOT_ASSESSED"
    })
    return pending.length > 0
      ? `Finding registry has ${pending.length} current finding(s) without final Verify decisions.`
      : undefined
  }
  if (!SubsystemVerdict.requiredFor(input.workflow, input.phase)) return
  if (!input.verdicts) return "Finding registry cannot reconcile a missing handoff verdict inventory."

  const inventory = [
    ...input.verdicts.confirmed.map((id) => ({ id, state: "CONFIRMED" })),
    ...input.verdicts.disproved.map((id) => ({ id, state: "DISPROVED" })),
    ...input.verdicts.suspected.map((item) => ({ id: item.id, state: "SUSPECTED" })),
    ...input.verdicts.inconclusive.map((item) => ({ id: item.id, state: "INCONCLUSIVE" })),
    ...input.verdicts.untestable.map((item) => ({ id: item.id, state: "UNTESTABLE" })),
  ] as const
  const resolve = (id: string) => current.find((item) => item.id === id || item.aliases.includes(id))
  const resolved = inventory.map((item) => ({ item, finding: resolve(item.id) }))
  const unknown = resolved.filter(({ finding }) => !finding)
  const divergent = resolved.filter(({ item, finding }) => {
    return finding?.currentRun?.review !== "ASSESSED" || finding.currentRun.disposition.state !== item.state
  })
  const represented = new Set(resolved.flatMap(({ finding }) => (finding ? [finding.id] : [])))
  const duplicate = resolved.length - unknown.length - represented.size
  const missing = current.filter((item) => !represented.has(item.id))
  if (unknown.length === 0 && divergent.length === 0 && duplicate === 0 && missing.length === 0) return
  return `Finding registry and handoff verdict inventory diverge (unknown ${unknown.length}, duplicate ${duplicate}, state ${divergent.length}, missing ${missing.length}).`
}
