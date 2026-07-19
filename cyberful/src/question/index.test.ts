// ── Interactive Question Cancellation Tests ─────────────────────
// Proves that producer interruption retracts a pending question from both the
//   service state and the live event stream before a successor can be blocked.
// → cyberful/src/question/index.ts — owns pending question lifecycle events.
// ─────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "@/bus"
import { InstanceDisposalRegistry } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { Question } from "."

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
const questionLayer = Layer.merge(busLayer, Question.layer.pipe(Layer.provide(busLayer))).pipe(
  Layer.provide(InstanceDisposalRegistry.layer),
)

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
