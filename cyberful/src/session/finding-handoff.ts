// ── Finding Handoff Reconciliation ──────────────────────────────
// Compares the phase handoff inventory with the durable finding registry before
//   allowing an engagement to advance.
// @docs/concepts/execution-model.md
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

  // ── Positive Verdicts Enter The Registry Before Handoff ────────
  // The handoff retains every tested hypothesis, including negative outcomes
  // that never produced enough positive evidence to become findings. Confirmed
  // and suspected entries must resolve to the current registry because both
  // assert affirmative target evidence. Known findings still reconcile exactly;
  // unresolved negative entries remain coverage history rather than being
  // promoted into the finding registry merely to satisfy the phase gate.
  //
  // @docs/concepts/execution-model.md
  // ─────────────────────────────────────────────────────────────────
  const inventory = [
    ...input.verdicts.confirmed.map((id) => ({ id, state: "CONFIRMED" })),
    ...input.verdicts.disproved.map((id) => ({ id, state: "DISPROVED" })),
    ...input.verdicts.suspected.map((item) => ({ id: item.id, state: "SUSPECTED" })),
    ...input.verdicts.inconclusive.map((item) => ({ id: item.id, state: "INCONCLUSIVE" })),
    ...input.verdicts.untestable.map((item) => ({ id: item.id, state: "UNTESTABLE" })),
  ] as const
  const resolve = (id: string) => current.find((item) => item.id === id || item.aliases.includes(id))
  const resolved = inventory.map((item) => ({ item, finding: resolve(item.id) }))
  const unregisteredPositive = resolved.filter(({ item, finding }) => {
    return !finding && (item.state === "CONFIRMED" || item.state === "SUSPECTED")
  })
  const known = resolved.flatMap(({ item, finding }) => (finding ? [{ item, finding }] : []))
  const divergent = known.filter(({ item, finding }) => {
    return finding.currentRun?.review !== "ASSESSED" || finding.currentRun.disposition.state !== item.state
  })
  const represented = new Set(known.map(({ finding }) => finding.id))
  const duplicate = known.length - represented.size
  const missing = current.filter((item) => !represented.has(item.id))
  if (unregisteredPositive.length === 0 && divergent.length === 0 && duplicate === 0 && missing.length === 0) return
  return `Finding registry and handoff verdict inventory diverge (unregistered-positive ${unregisteredPositive.length}, duplicate ${duplicate}, state ${divergent.length}, missing ${missing.length}).`
}
