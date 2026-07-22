// ── Interactive Question Lifecycle Tests ────────────────────────
// Proves cancellation cleanup and cross-process mailbox replies through the
//   same pending request contract consumed by the TUI.
// → cyberful/src/question/index.ts — owns pending question lifecycle events.
// → cyberful/src/question/mailbox.ts — persists externally selectable requests.
// ─────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "node:path"
import os from "node:os"
import { rm } from "node:fs/promises"
import { Bus } from "@/bus"
import { InstanceDisposalRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { Question } from "."
import { ApprovalMailbox } from "./mailbox"
import { QUESTION_INTERACTION_MIN_MS } from "./interaction"

const context = {
  directory: "/question-cancellation-test",
  worktree: "/question-cancellation-test",
  project: {
    id: ProjectID.make("question-cancellation-test"),
    worktree: "/question-cancellation-test",
    time: { created: 0, updated: 0 },
  },
}

const busLayer = Bus.layer
const mailboxRoot = path.join(os.tmpdir(), `question-mailbox-test-${process.pid}`)
const questionLayer = Layer.merge(
  busLayer,
  Question.layer.pipe(Layer.provide(busLayer), Layer.provide(ApprovalMailbox.layer(mailboxRoot))),
).pipe(Layer.provide(InstanceDisposalRegistry.layer))

beforeEach(() => rm(mailboxRoot, { recursive: true, force: true }))
afterEach(() => rm(mailboxRoot, { recursive: true, force: true }))

test("interrupting a question retracts its live blocker", async () => {
  const asked = Promise.withResolvers<void>()
  const retracted = Promise.withResolvers<void>()
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const question = yield* Question.Service
        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          if (event.type === "question.asked") asked.resolve()
          if (event.type === "question.rejected") retracted.resolve()
        })

        try {
          const fiber = yield* question
            .ask({
              sessionID: SessionID.make("ses_question_cancellation"),
              questions: [
                {
                  header: "Scope",
                  question: "Continue this phase?",
                  options: [{ label: "Continue", description: "Continue the active phase." }],
                },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => asked.promise)
          expect(yield* question.list()).toHaveLength(1)

          yield* Fiber.interrupt(fiber)
          yield* Effect.promise(() => retracted.promise)

          expect(yield* question.list()).toEqual([])
        } finally {
          unsubscribe()
        }
      }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(questionLayer), Effect.scoped),
    )
  } finally {
    stderr.mockRestore()
  }
})

test("an external mailbox selection resumes the live question", async () => {
  const asked = Promise.withResolvers<void>()
  const replies: unknown[] = []
  const mailbox = ApprovalMailbox.make(mailboxRoot)
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const question = yield* Question.Service
        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          if (event.type === "question.asked") asked.resolve()
          if (event.type === "question.replied") replies.push(event.properties)
        })

        try {
          const fiber = yield* question
            .ask({
              sessionID: SessionID.make("ses_question_external"),
              questions: [
                {
                  header: "Mutation",
                  question: "Allow the reversible tester-owned mutation?",
                  options: [
                    { label: "Approve", description: "Run the bounded mutation." },
                    { label: "Deny", description: "Leave state unchanged." },
                  ],
                  custom: false,
                },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => asked.promise)
          const pending = yield* Effect.promise(() => mailbox.list())
          expect(pending).toHaveLength(1)
          expect(pending[0]?.active).toBe(true)
          yield* Effect.promise(() => mailbox.answer(pending[0]?.id ?? "", [["Approve"]]))

          expect(yield* Fiber.join(fiber)).toEqual([["Approve"]])
          expect(replies).toHaveLength(1)
          expect(yield* question.list()).toEqual([])
          expect(yield* Effect.promise(() => mailbox.list())).toEqual([])
        } finally {
          unsubscribe()
        }
      }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(questionLayer), Effect.scoped),
    )
  } finally {
    stderr.mockRestore()
  }
})

test("immediate UI input cannot decide a question before it is visible", async () => {
  const asked = Promise.withResolvers<void>()
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const question = yield* Question.Service
        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          if (event.type === "question.asked") asked.resolve()
        })

        try {
          const fiber = yield* question
            .ask({
              sessionID: SessionID.make("ses_question_presentation_floor"),
              questions: [
                {
                  header: "Re-authenticate",
                  question: "Is the authenticated app visible again?",
                  options: [
                    { label: "Visible", description: "The authenticated app is visible." },
                    { label: "Unavailable", description: "Authentication could not be completed." },
                  ],
                },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => asked.promise)
          const [request] = yield* question.list()
          expect(request).toBeDefined()
          yield* question.reply({ requestID: request!.id, answers: [["Visible"]] })
          yield* question.reject(request!.id)
          yield* Effect.sleep("25 millis")
          expect(yield* question.list()).toHaveLength(1)

          yield* Effect.sleep(`${QUESTION_INTERACTION_MIN_MS} millis`)
          yield* question.reject(request!.id)
          const error = yield* Fiber.join(fiber).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Question.RejectedError)
          expect(yield* question.list()).toEqual([])
        } finally {
          unsubscribe()
        }
      }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(questionLayer), Effect.scoped),
    )
  } finally {
    stderr.mockRestore()
  }
})
