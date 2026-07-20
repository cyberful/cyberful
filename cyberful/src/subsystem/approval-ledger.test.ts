// ── Phase Approval Ledger Tests ──────────────────────────────────
// Proves exact approvals and refusals survive subsystem session replacement,
// while adjacent operations still reach the human decision boundary.
// → cyberful/src/subsystem/approval-ledger.ts — implements the memory-only ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemApprovalLedger } from "./approval-ledger"
import { SubsystemApprovalState } from "./approval-state"

const question = [
  {
    header: "Mutation",
    question: "Run the bounded operation?",
    options: [
      { label: "Approve once", description: "Permit this exact operation." },
      { label: "Reject", description: "Do not run it." },
    ],
  },
] as const

describe("phase approval ledger", () => {
  test("replays an accepted exact request without a second human prompt", async () => {
    let calls = 0
    const ledger = SubsystemApprovalLedger.create({
      askHuman: async () => {
        calls += 1
        return [["Approve once"]]
      },
      suspension: SubsystemApprovalState.create(),
    })

    expect(await ledger.ask(question, new AbortController().signal)).toEqual([["Approve once"]])
    expect(await ledger.ask(question, new AbortController().signal)).toEqual([["Approve once"]])
    expect(calls).toBe(1)
    expect(ledger.snapshot()).toEqual({ accepted: 1, rejected: 0, pending: 0 })
  })

  test("preserves a refusal and keeps a new operation subject to approval", async () => {
    let calls = 0
    const ledger = SubsystemApprovalLedger.create({
      askHuman: async (questions) => {
        calls += 1
        if (questions[0]?.question === question[0].question)
          throw Object.assign(new Error("declined"), { _tag: "QuestionRejectedError" })
        return [["Approve once"]]
      },
      suspension: SubsystemApprovalState.create(),
    })

    await expect(ledger.ask(question, new AbortController().signal)).rejects.toMatchObject({
      _tag: "QuestionRejectedError",
    })
    await expect(ledger.ask(question, new AbortController().signal)).rejects.toMatchObject({
      _tag: "QuestionRejectedError",
    })
    expect(
      await ledger.ask(
        [{ ...question[0], question: "Run a distinct bounded operation?" }],
        new AbortController().signal,
      ),
    ).toEqual([["Approve once"]])
    expect(calls).toBe(2)
    expect(ledger.snapshot()).toEqual({ accepted: 1, rejected: 1, pending: 0 })
  })
})
