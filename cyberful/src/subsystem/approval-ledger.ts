// ── Phase Approval Ledger ───────────────────────────────────────
// Retains accepted and rejected human decisions for one run phase so a local
// assist or deterministic recovery can reuse the exact authorization boundary.
// A differently shaped request is a new operation and must return to the human.
// The ledger is memory-only and is discarded when its owning phase completes.
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

type Decision =
  | { readonly status: "accepted"; readonly answers: HumanAnswers }
  | { readonly status: "rejected" }
  | { readonly status: "pending"; readonly result: Promise<Decision> }

function fingerprint(questions: ReadonlyArray<HumanQuestion>): string {
  return createHash("sha256").update(JSON.stringify(questions)).digest("hex")
}

function rejectedError(): Error & { readonly _tag: "QuestionRejectedError" } {
  return Object.assign(new Error("The human rejected this operation earlier in the same phase."), {
    _tag: "QuestionRejectedError" as const,
  })
}

async function unwrap(decision: Decision): Promise<HumanAnswers> {
  const settled = decision.status === "pending" ? await decision.result : decision
  if (settled.status === "accepted") return settled.answers
  throw rejectedError()
}

// ── One Exact Request Has One Human Decision ─────────────────────
// Fingerprints include question text, option labels, descriptions, and selection
// semantics. This intentionally avoids broad approval inference: recovery may
// replay the same request without another prompt, while adjacent work remains a
// fresh decision. Pending duplicates share the first promise, preventing two UIs
// from racing to decide the same operation during a session transition.
// ─────────────────────────────────────────────────────────────────
export function create(input: {
  readonly askHuman: AskHuman
  readonly suspension: SubsystemApprovalState.Controller
}): Ledger {
  const decisions = new Map<string, Decision>()

  const ask: AskHuman = async (questions, signal) => {
    const key = fingerprint(questions)
    const existing = decisions.get(key)
    if (existing) return unwrap(existing)

    const result: Promise<Decision> = input.suspension
      .wait(() => input.askHuman(questions, signal))
      .then((answers): Decision => ({ status: "accepted", answers }))
      .catch((error): Decision => {
        if (isQuestionRejected(error)) return { status: "rejected" }
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
    let rejected = 0
    let pending = 0
    for (const decision of decisions.values()) {
      if (decision.status === "accepted") accepted += 1
      else if (decision.status === "rejected") rejected += 1
      else pending += 1
    }
    return { accepted, rejected, pending }
  }

  return { ask, snapshot }
}

export * as SubsystemApprovalLedger from "./approval-ledger"
