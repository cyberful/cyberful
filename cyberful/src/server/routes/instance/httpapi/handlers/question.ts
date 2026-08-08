// ── Interactive Question Endpoint Handlers ──────────────────────
// Lists pending user questions and applies ordered replies or rejection choices,
// translating an absent question into the declared public failure.
// → cyberful/src/server/routes/instance/httpapi/groups/question.ts — defines accepted replies.
// ─────────────────────────────────────────────────────────────────

import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError, QuestionNotPresentedError } from "../errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const presented = Effect.fn("QuestionHttpApi.presented")(function* (ctx: {
      params: { requestID: QuestionID }
    }) {
      return yield* svc.present(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
    })

    const notPresented = (error: Question.NotPresentedError) =>
      new QuestionNotPresentedError({
        requestID: String(error.requestID),
        message: error.message,
      })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
          Effect.catchTag("Question.NotPresentedError", (error) => Effect.fail(notPresented(error))),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
        Effect.catchTag("Question.NotPresentedError", (error) => Effect.fail(notPresented(error))),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("presented", presented)
      .handle("reply", reply)
      .handle("reject", reject)
  }),
)
