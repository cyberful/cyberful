// ── External Approval Selector Tests ─────────────────────────────
// Verifies remote-friendly numeric, label, and custom selectors resolve against
//   the immutable question envelope instead of arbitrary free-form steering.
// → cyberful/src/cli/cmd/approval.ts — parses selectors for mailbox replies.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import type { PendingRequest } from "@/question/mailbox"
import { resolveSelectors } from "./approval"

function request(custom = false): PendingRequest {
  return {
    version: 1,
    id: "que_selector",
    sessionID: "ses_selector",
    createdAt: 1,
    ownerPID: process.pid,
    active: true,
    questions: [
      {
        header: "Mutation",
        question: "Allow the bounded mutation?",
        options: [
          { label: "Approve", description: "Continue." },
          { label: "Deny", description: "Stop." },
        ],
        custom,
      },
    ],
  }
}

test("resolves an option by one-based number or exact label", () => {
  expect(resolveSelectors(request(), ["#1"])).toEqual([["Approve"]])
  expect(resolveSelectors(request(), ["Deny"])).toEqual([["Deny"]])
})

test("rejects unknown fixed selectors and accepts declared custom input", () => {
  expect(() => resolveSelectors(request(), ["continue somehow"])).toThrow("not an allowed option")
  expect(resolveSelectors(request(true), ["wait until tomorrow"])).toEqual([["wait until tomorrow"]])
})
