// ── Durable Approval Mailbox Tests ───────────────────────────────
// Verifies owner-only persistence, option validation, first-decision wins, and
//   cleanup for the cross-process approval boundary.
// → cyberful/src/question/mailbox.ts — owns immutable requests and decisions.
// ─────────────────────────────────────────────────────────────────

import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { ApprovalMailbox, type Request } from "./mailbox"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-mailbox-test-"))
  roots.push(root)
  const mailbox = ApprovalMailbox.make(root)
  const request = {
    version: 1,
    id: "que_mailbox_test",
    sessionID: "ses_mailbox_test",
    createdAt: Date.now(),
    ownerPID: process.pid,
    questions: [
      {
        header: "Mutation",
        question: "Allow the bounded mutation?",
        options: [
          { label: "Approve", description: "Continue." },
          { label: "Deny", description: "Stop." },
        ],
        custom: false,
      },
    ],
  } satisfies Request
  await mailbox.publish(request)
  return { root, mailbox, request }
}

test("persists requests owner-only and accepts exactly one decision", async () => {
  const { root, mailbox, request } = await fixture()
  const pending = await mailbox.list()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.active).toBe(true)
  if (process.platform !== "win32") {
    expect((await stat(path.join(root, "approvals"))).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(root, "approvals", `${request.id}.request.json`))).mode & 0o777).toBe(0o600)
  }

  await mailbox.answer(request.id, [["Approve"]])
  await expect(mailbox.reject(request.id)).rejects.toThrow("already resolved")
  expect(await mailbox.wait(request.id, new AbortController().signal)).toEqual({
    status: "answered",
    answers: [["Approve"]],
    decidedAt: expect.any(Number),
  })
  await expect(mailbox.publish(request)).rejects.toThrow("already resolved")
  expect(await mailbox.wait(request.id, new AbortController().signal)).toEqual({
    status: "answered",
    answers: [["Approve"]],
    decidedAt: expect.any(Number),
  })
})

test("an invalid fixed selection does not consume the request", async () => {
  const { mailbox, request } = await fixture()
  await expect(mailbox.answer(request.id, [["Maybe"]])).rejects.toThrow("not an allowed choice")
  expect(await mailbox.list()).toHaveLength(1)
  await mailbox.answer(request.id, [["Deny"]])
})
