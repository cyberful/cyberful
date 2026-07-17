// ── Session Event Transport ──────────────────────────────────────
// Owns the global event subscription and one active prompt turn, projects the
//   current session tree through reducers, and confirms idle by event plus
//   polling so stale or missed status events cannot finish the wrong turn.
// ─────────────────────────────────────────────────────────────────

import type { Event, GlobalEvent, ControlPlaneClient } from "@/server/client"
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { makeRuntime } from "@/effect/run-service"
import * as Log from "@/util/log"
import { isRecord } from "@/util/record"
import {
  blockerStatus,
  bootstrapSessionData,
  createSessionData,
  flushInterrupted,
  pickBlockerView,
  reduceSessionData,
  type SessionData,
} from "./session-data"
import { replaySession } from "./session-replay"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  clearFinishedSubagents,
  createSubagentData,
  listSubagentQuestions,
  listSubagentTabs,
  reduceSubagentData,
  sameSubagentTab,
  snapshotSelectedSubagentData,
  SUBAGENT_BOOTSTRAP_LIMIT,
  SUBAGENT_DETAIL_BOOTSTRAP_LIMIT,
  type SubagentData,
} from "./subagent-data"
import { traceFooterOutput, writeSessionOutput } from "./stream"
import { toolDisplaySummary } from "../tool-display"
import type {
  FooterApi,
  FooterOutput,
  FooterPatch,
  FooterSubagentState,
  FooterSubagentTab,
  FooterView,
  RunFilePart,
  RunPrompt,
  RunPromptPart,
  StreamCommit,
} from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

const log = Log.create({ service: "run.stream.transport" })

type StreamInput = {
  sdk: ControlPlaneClient
  directory?: string
  sessionID: string
  thinking: boolean
  replay?: boolean
  replayLimit?: number
  system?: string
  workarea?: string
  limits: () => Record<string, number>
  footer: FooterApi
  trace?: Trace
  signal?: AbortSignal
}

type Wait = {
  tick: number
  armed: boolean
  live: boolean
  done: Deferred.Deferred<void, unknown>
}

export type SessionTurnInput = {
  agent: string | undefined
  prompt: RunPrompt
  files: RunFilePart[]
  includeFiles: boolean
  signal?: AbortSignal
}

export type SessionTransport = {
  runPromptTurn(input: SessionTurnInput): Promise<void>
  selectSubagent(sessionID: string | undefined): void
  close(): Promise<void>
}

type State = {
  data: SessionData
  subagent: SubagentData
  wait?: Wait
  tick: number
  fault?: unknown
  footerView: FooterView
  blockerTick: number
  selectedSubagent?: string
  blockers: Map<string, number>
}

type TransportService = {
  readonly runPromptTurn: (input: SessionTurnInput) => Effect.Effect<void, unknown>
  readonly selectSubagent: (sessionID: string | undefined) => Effect.Effect<void>
  readonly close: () => Effect.Effect<void>
}

class Service extends Context.Service<Service, TransportService>()("@cyberful/RunStreamTransport") {}

function sid(event: Event): string | undefined {
  if (event.type === "message.updated") {
    return event.properties.sessionID
  }

  if (event.type === "message.part.delta") {
    return event.properties.sessionID
  }

  if (event.type === "message.part.updated") {
    return event.properties.part.sessionID
  }

  if (
    event.type === "session.next.shell.started" ||
    event.type === "session.next.shell.ended" ||
    event.type === "session.next.skill.learned" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error" ||
    event.type === "session.status"
  ) {
    return event.properties.sessionID
  }

  return undefined
}

function subagentStatusPatch(event: Event, rootSessionID: string, subagent: SubagentData): FooterPatch | undefined {
  const sessionID = sid(event)
  if (!sessionID || sessionID === rootSessionID || !subagent.tabs.has(sessionID)) {
    return undefined
  }

  if (event.type === "message.updated") {
    return event.properties.info.role === "assistant" ? { status: "Sub-agent generating" } : undefined
  }

  if (event.type === "message.part.delta") {
    if (event.properties.field !== "text" || !event.properties.delta.trim()) {
      return undefined
    }

    return { status: "Sub-agent generating" }
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.type === "tool" && part.state.status === "pending") {
      return { status: `Queued ${toolDisplaySummary(part.tool, part.state.input)}` }
    }

    if (part.type === "tool" && part.state.status === "running") {
      return { status: `Executing ${toolDisplaySummary(part.tool, part.state.input)}` }
    }

    if ((part.type === "text" || part.type === "reasoning") && part.text.trim()) {
      return { status: "Sub-agent generating" }
    }

    return undefined
  }

  if (event.type === "session.status" && event.properties.status.type === "busy") {
    const message = event.properties.status.message?.trim()
    if (!message) {
      return undefined
    }

    if (message === "Generating output..." || message === "waiting for output...") {
      return { status: "Sub-agent generating" }
    }

    return { status: `Sub-agent ${message}` }
  }

  return undefined
}

function isEvent(value: unknown): value is Event {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const type = Reflect.get(value, "type")
  const properties = Reflect.get(value, "properties")
  return typeof type === "string" && !!properties && typeof properties === "object"
}

function isGlobalEvent(value: unknown): value is GlobalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const payload = Reflect.get(value, "payload")
  return !!payload && typeof payload === "object"
}

function globalPayloadEvent(value: unknown): Event | undefined {
  if (!isGlobalEvent(value)) {
    return undefined
  }

  const payload = value.payload
  if (payload.type === "sync") {
    return undefined
  }

  return isEvent(payload) ? payload : undefined
}

function isMatchingDisposeEvent(value: unknown, directory: string | undefined): boolean {
  if (!directory || !isGlobalEvent(value)) {
    return false
  }

  if (value.directory !== directory) {
    return false
  }

  return value.payload.type === "server.instance.disposed"
}

function active(event: Event, sessionID: string): boolean {
  if (sid(event) !== sessionID) {
    return false
  }

  if (event.type === "message.updated") {
    return event.properties.info.role === "assistant"
  }

  if (event.type === "message.part.delta" || event.type === "message.part.updated") {
    return false
  }

  if (event.type !== "session.status") {
    return true
  }

  return event.properties.status.type !== "idle"
}

// Races the turn's deferred completion against an abort signal.
function waitTurn(done: Wait["done"], signal: AbortSignal) {
  return Effect.raceAll([
    Deferred.await(done).pipe(Effect.as("idle" as const), Effect.exit),
    Effect.callback<"abort">((resume) => {
      if (signal.aborted) {
        resume(Effect.succeed("abort"))
        return Effect.void
      }

      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        resume(Effect.succeed("abort"))
      }

      signal.addEventListener("abort", onAbort, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", onAbort))
    }).pipe(Effect.exit),
  ]).pipe(Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value))))
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message || error.name
  }

  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message
    }

    if (typeof error.name === "string" && error.name.trim()) {
      return error.name
    }
  }

  return "unknown error"
}

function sameView(a: FooterView, b: FooterView) {
  if (a.type !== b.type) {
    return false
  }

  if (a.type === "prompt" && b.type === "prompt") {
    return true
  }

  if (a.type === "prompt" || b.type === "prompt") {
    return false
  }

  return a.request === b.request
}

function blockerOrder(order: Map<string, number>, id: string) {
  return order.get(id) ?? Number.MAX_SAFE_INTEGER
}

function firstByOrder<T extends { id: string }>(left: T[], right: T[], order: Map<string, number>) {
  return [...left, ...right].sort((a, b) => {
    const next = blockerOrder(order, a.id) - blockerOrder(order, b.id)
    if (next !== 0) {
      return next
    }

    return a.id.localeCompare(b.id)
  })[0]
}

function pickView(data: SessionData, subagent: SubagentData, order: Map<string, number>): FooterView {
  return pickBlockerView({
    question: firstByOrder(data.questions, listSubagentQuestions(subagent), order),
  })
}

function composeFooter(input: {
  patch?: FooterPatch
  subagent?: FooterSubagentState
  current: FooterView
  previous: FooterView
}) {
  let footer: FooterOutput | undefined

  if (input.subagent) {
    footer = {
      ...footer,
      subagent: input.subagent,
    }
  }

  if (!sameView(input.previous, input.current)) {
    footer = {
      ...footer,
      view: input.current,
    }
  }

  if (input.current.type !== "prompt") {
    footer = {
      ...footer,
      patch: {
        ...input.patch,
        status: blockerStatus(input.current),
      },
    }
    return footer
  }

  if (input.patch) {
    footer = {
      ...footer,
      patch: input.patch,
    }
    return footer
  }

  if (input.previous.type !== "prompt") {
    footer = {
      ...footer,
      patch: {
        status: "",
      },
    }
  }

  return footer
}

function traceTabs(trace: Trace | undefined, prev: FooterSubagentTab[], next: FooterSubagentTab[]) {
  const before = new Map(prev.map((item) => [item.sessionID, item]))
  const after = new Map(next.map((item) => [item.sessionID, item]))

  for (const [sessionID, tab] of after) {
    if (sameSubagentTab(before.get(sessionID), tab)) {
      continue
    }

    trace?.write("subagent.tab", {
      sessionID,
      tab,
    })
  }

  for (const sessionID of before.keys()) {
    if (after.has(sessionID)) {
      continue
    }

    trace?.write("subagent.tab", {
      sessionID,
      cleared: true,
    })
  }
}

function createLayer(input: StreamInput) {
  return Layer.fresh(
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const abort = yield* Scope.provide(scope)(
          Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (abort) => Effect.sync(() => abort.abort()),
          ),
        )
        let closed = false
        let closeStream = () => {}
        let streamCloseTask: Promise<void> | undefined
        const halt = () => {
          abort.abort()
        }
        const stop = () => {
          input.signal?.removeEventListener("abort", halt)
          abort.abort()
          closeStream()
        }
        const closeScope = () => {
          if (closed) {
            return Effect.void
          }

          closed = true
          stop()
          return Scope.close(scope, Exit.void)
        }

        input.signal?.addEventListener("abort", halt, { once: true })
        yield* Effect.addFinalizer(() => closeScope())

        const events = yield* Scope.provide(scope)(
          Effect.acquireRelease(
            Effect.promise(() =>
              input.sdk.global.event({
                signal: abort.signal,
              }),
            ),
            (events) =>
              Effect.promise(() =>
                events.stream.return().then(
                  () => undefined,
                  (error) => log.debug("event stream did not close cleanly", { error }),
                ),
              ),
          ),
        )
        closeStream = () => {
          streamCloseTask ??= events.stream
            .return()
            .then(() => undefined)
            .catch((error) => log.debug("event stream close request failed", { error }))
        }
        input.trace?.write("recv.subscribe", {
          sessionID: input.sessionID,
        })

        const state: State = {
          data: createSessionData(),
          subagent: createSubagentData(),
          tick: 0,
          footerView: { type: "prompt" },
          blockerTick: 0,
          blockers: new Map(),
        }
        let booting = true
        const buffered: Event[] = []
        const replayedParts = new Set<string>()
        const recovering = new Set<string>()
        const tracked = (sessionID: string | undefined) =>
          sessionID === input.sessionID || (!!sessionID && state.subagent.tabs.has(sessionID))
        const currentSubagentState = () => {
          if (state.selectedSubagent && !state.subagent.tabs.has(state.selectedSubagent)) {
            state.selectedSubagent = undefined
          }

          return snapshotSelectedSubagentData(state.subagent, state.selectedSubagent)
        }

        const seedBlocker = (id: string) => {
          if (state.blockers.has(id)) {
            return
          }

          state.blockerTick += 1
          state.blockers.set(id, state.blockerTick)
        }

        const trackBlocker = (event: Event) => {
          if (event.type !== "question.asked") {
            return
          }

          if (event.properties.sessionID !== input.sessionID && !state.subagent.tabs.has(event.properties.sessionID)) {
            return
          }

          seedBlocker(event.properties.id)
        }

        const releaseBlocker = (event: Event) => {
          if (event.type !== "question.replied" && event.type !== "question.rejected") {
            return
          }

          state.blockers.delete(event.properties.requestID)
        }

        const syncFooter = (commits: StreamCommit[], patch?: FooterPatch, nextSubagent?: FooterSubagentState) => {
          const current = pickView(state.data, state.subagent, state.blockers)
          const footer = composeFooter({
            patch,
            subagent: nextSubagent,
            current,
            previous: state.footerView,
          })

          if (commits.length === 0 && !footer) {
            state.footerView = current
            return
          }

          input.trace?.write("reduce.output", {
            commits,
            footer: traceFooterOutput(footer),
          })
          writeSessionOutput(
            {
              footer: input.footer,
              trace: input.trace,
            },
            {
              commits,
              footer,
            },
          )
          state.footerView = current
        }

        const resolveShellAgent = Effect.fn("RunStreamTransport.resolveShellAgent")(function* (
          agent: string | undefined,
        ) {
          if (agent) {
            return agent
          }

          const list = yield* Effect.promise(() =>
            input.sdk.app.agents(input.directory ? { directory: input.directory } : undefined, { throwOnError: true }),
          ).pipe(
            Effect.map((item) => item.data ?? []),
            Effect.orElseSucceed(() => []),
          )
          const next = list.find((item) => item.hidden !== true)?.name
          if (next) {
            return next
          }

          return yield* Effect.fail(new Error("no primary agent available for shell mode"))
        })

        const recoverQuestion = Effect.fn("RunStreamTransport.recoverQuestion")(function* (partID: string) {
          if (recovering.has(partID)) {
            return
          }

          recovering.add(partID)
          try {
            while (!closed && !abort.signal.aborted && !input.footer.isClosed) {
              if (state.data.questions.length > 0 || !state.data.tools.has(partID)) {
                return
              }

              const questions = yield* Effect.promise(() => input.sdk.question.list()).pipe(
                Effect.map((item) => (item.data ?? []).filter((request) => request.sessionID === input.sessionID)),
                Effect.orElseSucceed(() => []),
              )
              if (state.data.questions.length > 0 || !state.data.tools.has(partID)) {
                return
              }

              if (questions.length > 0) {
                bootstrapSessionData({
                  data: state.data,
                  questions,
                })
                for (const request of questions) {
                  seedBlocker(request.id)
                }
                input.trace?.write("question.recover", {
                  sessionID: input.sessionID,
                  requests: questions.map((request) => request.id),
                })
                syncFooter([])
                return
              }

              yield* Effect.sleep("250 millis")
            }
          } finally {
            recovering.delete(partID)
          }
        })

        const messages = (sessionID: string, limit?: number) =>
          Effect.promise(() =>
            input.sdk.session.messages({
              sessionID,
              ...(typeof limit === "number" ? { limit } : {}),
            }),
          ).pipe(
            Effect.map((item) => item.data ?? []),
            Effect.orElseSucceed(() => []),
          )

        const bootstrapSubagentHistory = Effect.fn("RunStreamTransport.bootstrapSubagentHistory")(function* (
          sessions: string[],
        ) {
          const seen = new Set<string>()
          let pending = sessions

          while (pending.length > 0 && !closed && !abort.signal.aborted && !input.footer.isClosed) {
            const next = pending.filter((sessionID) => !seen.has(sessionID))
            if (next.length === 0) {
              return
            }

            next.forEach((sessionID) => seen.add(sessionID))

            yield* Effect.forEach(
              next,
              (sessionID) =>
                messages(sessionID, SUBAGENT_DETAIL_BOOTSTRAP_LIMIT).pipe(
                  Effect.tap((messagesList) =>
                    Effect.sync(() => {
                      if (
                        !bootstrapSubagentCalls({
                          data: state.subagent,
                          sessionID,
                          messages: messagesList,
                          thinking: input.thinking,
                          limits: input.limits(),
                        })
                      ) {
                        return
                      }

                      syncFooter([], undefined, currentSubagentState())
                    }),
                  ),
                ),
              {
                concurrency: 4,
                discard: true,
              },
            )

            pending = [...state.subagent.tabs.keys()].filter((sessionID) => !seen.has(sessionID))
          }
        })

        // ── Session Bootstrap Uses One Fixed Fan-Out ────────────────
        // Initial messages, child sessions, and pending questions are independent.
        // Exactly three requests may run together; no data-dependent work is spawned.
        // Effect waits for the complete group before reducers observe any snapshot.
        // Each optional child/question failure degrades to an empty bounded list.
        // ─────────────────────────────────────────────────────────────────
        const bootstrap = Effect.fn("RunStreamTransport.bootstrap")(function* () {
          const [messagesList, children, questions] = yield* Effect.all(
            [
              messages(
                input.sessionID,
                input.replay
                  ? input.replayLimit === undefined
                    ? undefined
                    : Math.max(input.replayLimit, SUBAGENT_BOOTSTRAP_LIMIT)
                  : SUBAGENT_BOOTSTRAP_LIMIT,
              ),
              Effect.promise(() =>
                input.sdk.session.children({
                  sessionID: input.sessionID,
                }),
              ).pipe(
                Effect.map((item) => item.data ?? []),
                Effect.orElseSucceed(() => []),
              ),
              Effect.promise(() => input.sdk.question.list()).pipe(
                Effect.map((item) => item.data ?? []),
                Effect.orElseSucceed(() => []),
              ),
            ],
            {
              concurrency: 3,
            },
          )

          const sessionQuestions = questions.filter((item) => item.sessionID === input.sessionID)
          const history = input.replay
            ? replaySession({
                messages: messagesList,
                questions: sessionQuestions,
                thinking: input.thinking,
                limits: input.limits(),
              })
            : undefined
          const replay =
            history && input.replayLimit !== undefined && messagesList.length > input.replayLimit
              ? replaySession({
                  messages: messagesList.slice(-input.replayLimit),
                  questions: sessionQuestions,
                  thinking: input.thinking,
                  limits: input.limits(),
                })
              : history

          replayedParts.clear()
          if (history) {
            state.data = history.data
          }

          if (!history) {
            bootstrapSessionData({
              data: state.data,
              questions: sessionQuestions,
            })
          }

          if (replay) {
            for (const [partID] of replay.data.text) {
              if (!replay.data.part.has(partID)) {
                continue
              }

              replayedParts.add(partID)
            }
          }

          bootstrapSubagentData({
            data: state.subagent,
            messages: messagesList,
            children,
            questions,
          })
          clearFinishedSubagents(state.subagent)

          for (const request of [...state.data.questions, ...listSubagentQuestions(state.subagent)].sort((a, b) =>
            a.id.localeCompare(b.id),
          )) {
            seedBlocker(request.id)
          }

          if (replay) {
            const activeCommitIDs = new Set([...state.data.part.keys(), ...state.data.tools])
            for (const commit of replay.commits) {
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)

              if (commit.partID && activeCommitIDs.has(commit.partID)) {
                continue
              }

              yield* Effect.promise(() => input.footer.idle()).pipe(Effect.orElseSucceed(() => undefined))
            }
          }

          const snapshot = currentSubagentState()
          traceTabs(input.trace, [], snapshot.tabs)
          syncFooter([], replay?.patch, snapshot)
          if (replay) {
            yield* Effect.promise(() => input.footer.idle()).pipe(Effect.orElseSucceed(() => undefined))
          }

          booting = false
          yield* drainBuffered()

          const sessions = [...state.subagent.tabs.keys()]
          if (sessions.length === 0) {
            return
          }

          yield* bootstrapSubagentHistory(sessions).pipe(
            Effect.forkIn(scope, { startImmediately: true }),
            Effect.asVoid,
          )
        })

        const idle = Effect.fn("RunStreamTransport.idle")((fallback: boolean) =>
          Effect.promise(() => input.sdk.session.status()).pipe(
            Effect.map((out) => {
              const item = out.data?.[input.sessionID]
              return !item || item.type === "idle"
            }),
            Effect.orElseSucceed(() => fallback),
          ),
        )

        // ── Turn Settlement Is Deliberately Idempotent ──────────────
        // Stream failure, idle events, polling, send completion, and cancellation
        // can all observe the same turn boundary. State ownership is cleared before
        // completing its Deferred, so exactly one path wins and later paths receive
        // `false` without changing the result. Discarding that boolean is intentional;
        // Deferred completion itself cannot fail and no operational error is hidden.
        // ─────────────────────────────────────────────────────────────────
        const fail = Effect.fn("RunStreamTransport.fail")(function* (error: unknown) {
          if (state.fault) {
            return
          }

          state.fault = error
          const next = state.wait
          state.wait = undefined
          if (!next) {
            return
          }

          yield* Deferred.fail(next.done, error).pipe(Effect.asVoid)
        })

        const touch = (event: Event) => {
          const next = state.wait
          if (!next || !active(event, input.sessionID)) {
            return
          }

          next.live = true
        }

        const complete = Effect.fn("RunStreamTransport.complete")(function* (next: Wait, fallback: boolean) {
          if (state.wait !== next || !next.armed || !next.live) {
            return
          }

          if (!(yield* idle(fallback)) || state.wait !== next) {
            return
          }

          state.tick = next.tick + 1
          state.wait = undefined
          yield* Deferred.succeed(next.done, undefined).pipe(Effect.asVoid)
        })

        const mark = Effect.fn("RunStreamTransport.mark")(function* (event: Event) {
          if (
            event.type !== "session.status" ||
            event.properties.sessionID !== input.sessionID ||
            event.properties.status.type !== "idle"
          ) {
            return
          }

          const next = state.wait
          if (!next) {
            return
          }

          yield* complete(next, true)
        })

        const poll = Effect.fn("RunStreamTransport.poll")(function* (next: Wait, signal: AbortSignal) {
          while (state.wait === next && !signal.aborted && !input.footer.isClosed && !closed) {
            yield* Effect.sleep("250 millis")
            yield* complete(next, false)
          }
        })

        const flush = (type: "turn.abort" | "turn.cancel") => {
          const commits: StreamCommit[] = []
          flushInterrupted(state.data, commits)
          syncFooter(commits)
          input.trace?.write(type, {
            sessionID: input.sessionID,
          })
        }

        const applyEvent = Effect.fn("RunStreamTransport.applyEvent")(function* (event: Event) {
          if (event.type === "message.part.delta" && event.properties.sessionID === input.sessionID) {
            if (replayedParts.has(event.properties.partID)) {
              const seen = state.data.text.get(event.properties.partID) ?? ""
              if (
                event.properties.mode === "replace"
                  ? seen === event.properties.delta
                  : seen.endsWith(event.properties.delta)
              ) {
                return
              }

              replayedParts.delete(event.properties.partID)
            }
          }

          trackBlocker(event)

          const prev = event.type === "message.part.updated" ? listSubagentTabs(state.subagent) : undefined
          const next = reduceSessionData({
            data: state.data,
            event,
            sessionID: input.sessionID,
            thinking: input.thinking,
            limits: input.limits(),
          })
          state.data = next.data

          if (
            event.type === "message.part.updated" &&
            event.properties.part.sessionID === input.sessionID &&
            event.properties.part.type === "tool" &&
            event.properties.part.tool === "question" &&
            event.properties.part.state.status === "running" &&
            state.data.questions.length === 0
          ) {
            yield* recoverQuestion(event.properties.part.id).pipe(
              Effect.forkIn(scope, { startImmediately: true }),
              Effect.asVoid,
            )
          }

          const changed = reduceSubagentData({
            data: state.subagent,
            event,
            sessionID: input.sessionID,
            thinking: input.thinking,
            limits: input.limits(),
          })
          if (changed && prev) {
            traceTabs(input.trace, prev, listSubagentTabs(state.subagent))
          }
          releaseBlocker(event)

          syncFooter(
            next.commits,
            next.footer?.patch ?? subagentStatusPatch(event, input.sessionID, state.subagent),
            changed ? currentSubagentState() : undefined,
          )

          touch(event)
          yield* mark(event)
        })

        const drainBuffered = Effect.fn("RunStreamTransport.drainBuffered")(function* () {
          let pending = buffered.splice(0)
          while (pending.length > 0) {
            const next: Event[] = []
            let changed = false
            for (const event of pending) {
              if (!tracked(sid(event))) {
                next.push(event)
                continue
              }

              changed = true
              yield* applyEvent(event)
            }

            if (!changed) {
              buffered.push(...next)
              return
            }

            pending = next
          }
        })

        const watch = Effect.fn("RunStreamTransport.watch")(() =>
          Stream.fromAsyncIterable(events.stream, (error) =>
            error instanceof Error ? error : new Error(String(error)),
          ).pipe(
            Stream.takeUntil(() => input.footer.isClosed || abort.signal.aborted),
            Stream.runForEach(
              Effect.fn("RunStreamTransport.event")(function* (item: unknown) {
                if (input.footer.isClosed) {
                  abort.abort()
                  return
                }

                if (isMatchingDisposeEvent(item, input.directory)) {
                  yield* fail(new Error("instance disposed"))
                  yield* closeScope()
                  return
                }

                const event = globalPayloadEvent(item)
                if (!event) {
                  return
                }

                const sessionID = sid(event)
                if (booting) {
                  if (sessionID) {
                    input.trace?.write("recv.event", event)
                    buffered.push(event)
                  }
                  return
                }

                if (!tracked(sessionID)) {
                  if (sessionID) {
                    input.trace?.write("recv.event", event)
                    buffered.push(event)
                  }
                  return
                }

                input.trace?.write("recv.event", event)
                yield* applyEvent(event)
                yield* drainBuffered()
              }),
            ),
            Effect.catch((error) => (abort.signal.aborted ? Effect.void : fail(error))),
            Effect.ensuring(
              Effect.gen(function* () {
                if (!abort.signal.aborted && !state.fault) {
                  yield* fail(new Error("global event stream closed"))
                }
                closeStream()
              }),
            ),
          ),
        )

        yield* Scope.provide(scope)(watch().pipe(Effect.forkScoped))
        yield* bootstrap()

        const runPromptTurn = Effect.fn("RunStreamTransport.runPromptTurn")(function* (next: SessionTurnInput) {
          if (closed || next.signal?.aborted || input.footer.isClosed) {
            return
          }

          if (state.fault) {
            yield* Effect.fail(state.fault)
            return
          }

          if (state.wait) {
            yield* Effect.fail(new Error("prompt already running"))
            return
          }

          const prev = listSubagentTabs(state.subagent)
          if (clearFinishedSubagents(state.subagent)) {
            const snapshot = currentSubagentState()
            traceTabs(input.trace, prev, snapshot.tabs)
            syncFooter([], undefined, snapshot)
          }

          const item: Wait = {
            tick: state.tick,
            armed: false,
            live: false,
            done: yield* Deferred.make<void, unknown>(),
          }
          state.wait = item
          state.data.announced = false

          const turn = new AbortController()
          const stop = () => {
            turn.abort()
          }
          next.signal?.addEventListener("abort", stop, { once: true })
          abort.signal.addEventListener("abort", stop, { once: true })
          yield* poll(item, turn.signal).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

          const req = {
            sessionID: input.sessionID,
            agent: next.agent,
            system: input.system,
            workarea: input.workarea,
            parts: [
              ...(next.includeFiles ? next.files : []),
              { type: "text" as const, text: next.prompt.text },
              ...next.prompt.parts,
            ],
          }
          const command = next.prompt.command
          const send =
            next.prompt.mode === "shell"
              ? Effect.sync(() => {
                  input.trace?.write("send.shell", {
                    sessionID: input.sessionID,
                    command: next.prompt.text,
                  })
                }).pipe(
                  Effect.andThen(
                    resolveShellAgent(next.agent)
                      .pipe(
                        Effect.flatMap((agent) =>
                          Effect.promise(() =>
                            input.sdk.session.shell(
                              {
                                sessionID: input.sessionID,
                                agent,
                                command: next.prompt.text,
                              },
                              { signal: turn.signal, throwOnError: true },
                            ),
                          ),
                        ),
                      )
                      .pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            input.trace?.write("send.shell.ok", {
                              sessionID: input.sessionID,
                            })
                            item.armed = true
                            item.live = true
                          }),
                        ),
                        Effect.flatMap(() => Deferred.succeed(item.done, undefined).pipe(Effect.asVoid)),
                        Effect.catch((error) => Deferred.fail(item.done, error).pipe(Effect.asVoid)),
                        Effect.forkIn(scope, { startImmediately: true }),
                        Effect.asVoid,
                      ),
                  ),
                )
              : command
                ? Effect.sync(() => {
                    input.trace?.write("send.command", { sessionID: input.sessionID, command: command.name })
                  }).pipe(
                    Effect.andThen(
                      Effect.promise(() =>
                        input.sdk.session.command(
                          {
                            sessionID: input.sessionID,
                            agent: next.agent,
                            command: command.name,
                            arguments: command.arguments,
                            system: input.system,
                            workarea: input.workarea,
                            parts: [
                              ...(next.includeFiles ? next.files : []),
                              ...next.prompt.parts.filter(
                                (item): item is Extract<RunPromptPart, { type: "file" }> => item.type === "file",
                              ),
                            ],
                          },
                          { signal: turn.signal },
                        ),
                      ).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            input.trace?.write("send.command.ok", {
                              sessionID: input.sessionID,
                              command: command.name,
                            })
                            item.armed = true
                            item.live = true
                          }),
                        ),
                        Effect.flatMap(() => Deferred.succeed(item.done, undefined).pipe(Effect.asVoid)),
                        Effect.catch((error) => Deferred.fail(item.done, error).pipe(Effect.asVoid)),
                        Effect.forkIn(scope, { startImmediately: true }),
                        Effect.asVoid,
                      ),
                    ),
                  )
                : Effect.sync(() => {
                    input.trace?.write("send.prompt", req)
                  }).pipe(
                    Effect.andThen(
                      Effect.promise(() =>
                        input.sdk.session.promptAsync(req, {
                          signal: turn.signal,
                        }),
                      ),
                    ),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        input.trace?.write("send.prompt.ok", {
                          sessionID: input.sessionID,
                        })
                        item.armed = true
                      }),
                    ),
                  )

          yield* send.pipe(
            Effect.flatMap(() => {
              if (turn.signal.aborted || next.signal?.aborted || input.footer.isClosed || closed) {
                if (state.wait === item) {
                  state.wait = undefined
                }
                flush("turn.abort")
                return Effect.void
              }

              if (!input.footer.isClosed && !state.data.announced) {
                input.trace?.write("ui.patch", {
                  phase: "running",
                  status: "waiting for assistant",
                })
                input.footer.event({
                  type: "turn.wait",
                })
              }

              if (state.tick > item.tick) {
                if (state.wait === item) {
                  state.wait = undefined
                }
                return Effect.void
              }

              return waitTurn(item.done, turn.signal).pipe(
                Effect.flatMap((status) =>
                  Effect.sync(() => {
                    if (state.wait === item) {
                      state.wait = undefined
                    }

                    if (status === "abort") {
                      flush("turn.abort")
                    }
                  }),
                ),
              )
            }),
            Effect.catch((error) => {
              if (state.wait === item) {
                state.wait = undefined
              }

              const canceled = turn.signal.aborted || next.signal?.aborted === true || input.footer.isClosed || closed
              if (canceled) {
                flush("turn.cancel")
                return Effect.void
              }

              if (error === state.fault) {
                return Effect.fail(error)
              }

              input.trace?.write("send.prompt.error", {
                sessionID: input.sessionID,
                error: formatUnknownError(error),
              })
              return Effect.fail(error)
            }),
            Effect.ensuring(
              Effect.sync(() => {
                input.trace?.write("turn.end", {
                  sessionID: input.sessionID,
                })
                next.signal?.removeEventListener("abort", stop)
                abort.signal.removeEventListener("abort", stop)
              }),
            ),
          )
          return
        })

        const selectSubagent = Effect.fn("RunStreamTransport.selectSubagent")((sessionID: string | undefined) =>
          Effect.sync(() => {
            if (closed) {
              return
            }

            const next = sessionID && state.subagent.tabs.has(sessionID) ? sessionID : undefined
            if (state.selectedSubagent === next) {
              return
            }

            state.selectedSubagent = next
            syncFooter([], undefined, currentSubagentState())
          }),
        )

        const close = Effect.fn("RunStreamTransport.close")(function* () {
          yield* closeScope()
        })

        return Service.of({
          runPromptTurn,
          selectSubagent,
          close,
        })
      }),
    ),
  )
}

// ── One Subscription Serves One Active Turn At A Time ────────────
// A background watcher consumes the ordered global stream, filters the selected
// session tree, reduces relevant events, and writes their projection to the
// footer. An idle status resolves only the currently armed turn wait. The prompt
// queue guarantees no second `runPromptTurn` can replace that owner, and close
// ends the subscription scope before returning.
// ─────────────────────────────────────────────────────────────────
export async function createSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const runtime = makeRuntime(Service, createLayer(input))
  await runtime.runPromise(() => Effect.void)

  return {
    runPromptTurn: (next) => runtime.runPromise((svc) => svc.runPromptTurn(next)),
    selectSubagent: (sessionID) => runtime.runSync((svc) => svc.selectSubagent(sessionID)),
    close: () => runtime.runPromise((svc) => svc.close()),
  }
}
