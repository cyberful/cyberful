// ── Phase Approval Ledger ───────────────────────────────────────
// Retains accepted human decisions for one run phase so a local assist or
// deterministic recovery can reuse the exact authorization boundary. Rejections
// are counted but not replayed, and every differently shaped request is new. The
// ledger is memory-only and is discarded when its owning phase completes.
// → cyberful/src/subsystem/phase-runner.ts — owns one ledger per phase.
// @docs/runtimes/fallback-inference.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import type { AskHuman, HumanAnswers, HumanQuestion } from "./human-question"
import { isQuestionRejected } from "./human-question"
import type { SubsystemApprovalState } from "./approval-state"

export interface Snapshot {
  readonly accepted: number
  readonly rejected: number
  readonly pending: number
}

export interface Ledger {
  readonly ask: AskHuman
  readonly snapshot: () => Snapshot
}

type AcceptedDecision = { readonly status: "accepted"; readonly answers: HumanAnswers }
type Decision = AcceptedDecision | { readonly status: "pending"; readonly result: Promise<AcceptedDecision> }

function fingerprint(questions: ReadonlyArray<HumanQuestion>): string {
  return createHash("sha256").update(JSON.stringify(questions)).digest("hex")
}

async function unwrap(decision: Decision): Promise<HumanAnswers> {
  const settled = decision.status === "pending" ? await decision.result : decision
  return settled.answers
}

// ── Refusals Must Be Re-Asked ────────────────────────────────────
// Fingerprints include question text, option labels, descriptions, and selection
// semantics. Recovery may reuse an exact accepted authority, while adjacent work
// remains a fresh decision. A refusal is counted but never retained: retrying the
// operation must create a new visible question instead of manufacturing a second
// human decline. Pending duplicates still share the first live prompt, preventing
// two UIs from racing to decide one operation during a session transition.
// ─────────────────────────────────────────────────────────────────
export function create(input: {
  readonly askHuman: AskHuman
  readonly suspension: SubsystemApprovalState.Controller
}): Ledger {
  const decisions = new Map<string, Decision>()
  let rejected = 0

  const ask: AskHuman = async (questions, signal) => {
    const key = fingerprint(questions)
    const existing = decisions.get(key)
    if (existing) return unwrap(existing)

    const result: Promise<AcceptedDecision> = input.suspension
      .wait(() => input.askHuman(questions, signal))
      .then((answers): AcceptedDecision => ({ status: "accepted", answers }))
      .catch((error): never => {
        if (isQuestionRejected(error)) rejected += 1
        throw error
      })
    decisions.set(key, { status: "pending", result })
    try {
      const settled = await result
      decisions.set(key, settled)
      return unwrap(settled)
    } catch (error) {
      decisions.delete(key)
      throw error
    }
  }

  const snapshot = (): Snapshot => {
    let accepted = 0
    let pending = 0
    for (const decision of decisions.values()) {
      if (decision.status === "accepted") accepted += 1
      else pending += 1
    }
    return { accepted, rejected, pending }
  }

  return { ask, snapshot }
}

export * as SubsystemApprovalLedger from "./approval-ledger"
