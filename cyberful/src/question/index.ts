// ── Interactive Question Lifecycle ──────────────────────────────
// Validates question payloads and owns pending request completion, rejection,
// publication, and scoped cleanup for one project instance.
// → cyberful/src/question/schema.ts — defines stable question identifiers.
// → cyberful/src/bus/index.ts — publishes user-visible question state changes.
// ─────────────────────────────────────────────────────────────────

import { Effect, Layer, Schema, Context } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import * as Log from "@/util/log"
import { QuestionID } from "./schema"
import { ApprovalMailbox } from "./mailbox"

const log = Log.create({ service: "question" })

// ── Question Schemas Describe Data, Not Class Identity ───────────
// Requests cross bus and HTTP boundaries as plain structured data, and no
// consumer branches on a class prototype. Schema.Struct therefore supplies the
// runtime contract while its inferred type remains the internal representation.
// Ask sites can retain nested readonly values without decoding them into wrapper
// instances that would change neither validation nor downstream behavior.
// ─────────────────────────────────────────────────────────────────

export const Option = Schema.Struct({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}).annotate({ identifier: "QuestionOption" })
export type Option = Schema.Schema.Type<typeof Option>

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export type Prompt = Schema.Schema.Type<typeof Prompt>

export const Tool = Schema.Struct({
  messageID: MessageID,
  callID: Schema.String,
}).annotate({ identifier: "QuestionTool" })
export type Tool = Schema.Schema.Type<typeof Tool>

export const Request = Schema.Struct({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export type Reply = Schema.Schema.Type<typeof Reply>

const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "QuestionReplied" })

const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
}).annotate({ identifier: "QuestionRejected" })

export const Event = {
  Asked: BusEvent.define("question.asked", Request),
  Replied: BusEvent.define("question.replied", Replied),
  Rejected: BusEvent.define("question.rejected", Rejected),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const mailbox = yield* ApprovalMailbox.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        return {
          pending: new Map<QuestionID, PendingEntry>(),
        }
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      log.info("asking", { id, questions: input.questions.length })

      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      const entry = { info }
      pending.set(id, entry)
      let published = false

      // ── One Durable Decision Resumes Every Question Surface ────────
      // The immutable owner-only mailbox request is published before the live
      // event, so a TUI and an external CLI always resolve the same request ID.
      // Both writers compete for one exclusive response file; this owner consumes
      // that decision, publishes the normal bus event, and resumes the phase.
      // Cancellation removes both files and retracts only a question that was
      // actually visible, so a dead phase cannot authorize a later execution.
      // ─────────────────────────────────────────────────────────────────
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            mailbox.publish({
              version: 1,
              id: String(id),
              sessionID: input.sessionID,
              questions: input.questions,
              createdAt: Date.now(),
              ownerPID: process.pid,
            }),
          )
          yield* bus.publish(Event.Asked, info)
          published = true
          const decision = yield* Effect.promise((signal) => mailbox.wait(String(id), signal))
          if (pending.get(id) !== entry) return yield* new RejectedError()
          pending.delete(id)
          if (decision.status === "rejected") {
            yield* bus.publish(Event.Rejected, {
              sessionID: info.sessionID,
              requestID: id,
            })
            return yield* new RejectedError()
          }
          const answers = decision.answers.map((answer) => [...answer])
          yield* bus.publish(Event.Replied, {
            sessionID: info.sessionID,
            requestID: id,
            answers,
          })
          return answers
        }),
        Effect.gen(function* () {
          const unresolved = pending.get(id) === entry
          if (unresolved) pending.delete(id)
          yield* Effect.promise(() => mailbox.remove(String(id)))
          if (unresolved && published)
            yield* bus.publish(Event.Rejected, {
              sessionID: info.sessionID,
              requestID: id,
            })
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      if (!pending.has(input.requestID)) {
        log.warn("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      log.info("replied", { requestID: input.requestID, answers: input.answers })
      yield* Effect.promise(() => mailbox.answer(String(input.requestID), input.answers))
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      if (!pending.has(requestID)) {
        log.warn("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      log.info("rejected", { requestID })
      yield* Effect.promise(() => mailbox.reject(String(requestID)))
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(ApprovalMailbox.defaultLayer))

export * as Question from "."
