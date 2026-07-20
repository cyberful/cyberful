// ── Private Gateway Question IPC ──────────────────────────────────
// Bridges standalone phase gateways to the in-process human question callback
// through bounded, owner-only, atomically published request and response files.
// → cyberful/src/subsystem/gateway/server.ts — issues blocking gateway questions.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises"
import { isRecord } from "@/util/record"
import { observePromise } from "@/util/promise"

const REQUEST_SUFFIX = ".request.json"
const PROCESSING_SUFFIX = ".processing.json"
const RESPONSE_SUFFIX = ".response.json"
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_DIRECTORY_ENTRIES = 512
const MAX_REQUESTS_PER_SCAN = 64
const MAX_RETAINED_FAILURES = 64
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 20
const MAX_ANSWER_VALUES = 20
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_STOP_TIMEOUT_MS = 2_000
const DEFAULT_POLL_INTERVAL_MS = 40

export interface HumanQuestion {
  question: string
  header: string
  options: ReadonlyArray<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export type HumanAnswers = ReadonlyArray<ReadonlyArray<string>>
export type AskHuman = (questions: ReadonlyArray<HumanQuestion>, signal: AbortSignal) => Promise<HumanAnswers>

interface QuestionRequest {
  id: string
  questions: HumanQuestion[]
}

interface StartOptions {
  // null keeps a phase-owned approval pending until answer or lifecycle cancellation.
  requestTimeoutMs?: number | null
  stopTimeoutMs?: number
  pollIntervalMs?: number
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function positiveDuration(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function parseQuestion(input: unknown): HumanQuestion | undefined {
  if (!isRecord(input)) return
  if (!boundedString(input.question, 8_000) || !boundedString(input.header, 30) || !Array.isArray(input.options)) return
  if (input.options.length > MAX_OPTIONS) return
  const options: Array<{ label: string; description: string }> = []
  for (const option of input.options) {
    if (!isRecord(option) || !boundedString(option.label, 200) || !boundedString(option.description, 2_000)) return
    options.push({ label: option.label, description: option.description })
  }
  if (input.multiple !== undefined && typeof input.multiple !== "boolean") return
  if (input.custom !== undefined && typeof input.custom !== "boolean") return
  return {
    question: input.question,
    header: input.header,
    options,
    ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
    ...(input.custom === undefined ? {} : { custom: input.custom }),
  }
}

function parseRequest(raw: string, expectedID: string): QuestionRequest {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    throw new Error("question bridge request contains invalid JSON", { cause: error })
  }
  if (
    !isRecord(input) ||
    input.id !== expectedID ||
    !boundedString(input.id, 128) ||
    !Array.isArray(input.questions) ||
    input.questions.length < 1 ||
    input.questions.length > MAX_QUESTIONS
  )
    throw new Error("question bridge request has an invalid envelope")
  const questions: HumanQuestion[] = []
  for (const question of input.questions) {
    const parsed = parseQuestion(question)
    if (!parsed) throw new Error("question bridge request has an invalid question")
    questions.push(parsed)
  }
  return { id: input.id, questions }
}

function parseAnswers(input: unknown, questions: readonly HumanQuestion[]): HumanAnswers {
  if (!Array.isArray(input) || input.length !== questions.length)
    throw new Error("human question callback returned an invalid answer envelope")
  const answers: string[][] = []
  for (const answer of input) {
    if (!Array.isArray(answer) || answer.length > MAX_ANSWER_VALUES)
      throw new Error("human question callback returned an invalid answer")
    const values: string[] = []
    for (const value of answer) {
      if (!boundedString(value, 8_000)) throw new Error("human question callback returned an invalid answer")
      values.push(value)
    }
    answers.push(values)
  }
  return answers
}

async function readRequest(filePath: string) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error("question bridge request is not a regular file")
    if (metadata.size > MAX_REQUEST_BYTES) throw new Error("question bridge request exceeds 64 KiB")
    const raw = await handle.readFile("utf8")
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new Error("question bridge request exceeds 64 KiB")
    return raw
  } finally {
    await handle.close()
  }
}

async function publish(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new Error("question bridge response exceeds 64 KiB")
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let failure: unknown
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" })
    await rename(temporary, filePath)
    return
  } catch (error) {
    failure = error
  }
  try {
    await rm(temporary, { force: true })
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], "question bridge publication and temporary cleanup failed")
  }
  throw failure instanceof Error ? failure : new Error("question bridge publication failed", { cause: failure })
}

function abortReason(signal: AbortSignal, fallback: string) {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback)
}

function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(abortReason(signal, "question bridge stopped"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function abortable<A>(promise: Promise<A>, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<A>((resolve, reject) => {
    let settled = false
    const complete = (operation: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      operation()
    }
    const abort = () => complete(() => reject(abortReason(signal, "question bridge request aborted")))
    signal.addEventListener("abort", abort, { once: true })
    observePromise(promise, {
      fulfilled: (value) => complete(() => resolve(value)),
      rejected: (error) => complete(() => reject(error)),
    })
  })
}

async function askWithDeadline(
  ask: AskHuman,
  questions: readonly HumanQuestion[],
  lifecycle: AbortSignal,
  timeoutMs: number | null,
) {
  const controller = new AbortController()
  const stop = () => controller.abort(abortReason(lifecycle, "question bridge stopped"))
  if (lifecycle.aborted) stop()
  else lifecycle.addEventListener("abort", stop, { once: true })
  const timeout =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () => controller.abort(new Error(`question bridge request timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
  timeout?.unref?.()
  try {
    const pending = Promise.resolve().then(() => ask(questions, controller.signal))
    return await abortable(pending, controller.signal)
  } finally {
    if (timeout) clearTimeout(timeout)
    lifecycle.removeEventListener("abort", stop)
  }
}

async function requestNames(directory: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const handle = await opendir(directory)
  const requests: string[] = []
  let entries = 0
  try {
    while (requests.length < MAX_REQUESTS_PER_SCAN) {
      signal.throwIfAborted()
      const entry = await handle.read()
      if (!entry) break
      entries += 1
      if (entries > MAX_DIRECTORY_ENTRIES) throw new Error("question bridge directory exceeds 512 entries")
      if (entry.isFile() && entry.name.endsWith(REQUEST_SUFFIX)) requests.push(entry.name)
    }
  } finally {
    await handle.close()
  }
  return requests.toSorted()
}

async function processRequest(
  directory: string,
  name: string,
  ask: AskHuman,
  lifecycle: AbortSignal,
  timeoutMs: number | null,
) {
  const requestID = name.slice(0, -REQUEST_SUFFIX.length)
  const requestPath = path.join(directory, name)
  const processingPath = path.join(directory, `${requestID}${PROCESSING_SUFFIX}`)
  const responsePath = path.join(directory, `${requestID}${RESPONSE_SUFFIX}`)
  try {
    await rename(requestPath, processingPath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }

  let failure: unknown
  try {
    let response: unknown
    try {
      const request = parseRequest(await readRequest(processingPath), requestID)
      const answers = parseAnswers(
        await askWithDeadline(ask, request.questions, lifecycle, timeoutMs),
        request.questions,
      )
      response = { id: request.id, answers }
    } catch (error) {
      response = { error: errorDetail(error) }
    }
    await publish(responsePath, response)
  } catch (error) {
    failure = error
  }
  try {
    await rm(processingPath, { force: true })
  } catch (cleanupError) {
    if (failure)
      throw new AggregateError([failure, cleanupError], "question bridge request and claimed-file cleanup failed")
    throw cleanupError
  }
  if (failure)
    throw failure instanceof Error
      ? failure
      : new Error("question bridge request processing failed", { cause: failure })
}

async function waitBounded(promise: Promise<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`question bridge stop timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export interface Bridge {
  directory: string
  stop(): Promise<void>
}

// ── One Pump Owns Discovery, Questions, And Cleanup ──────────────────
// The bridge claims each request by rename and handles requests serially, which
// bounds both filesystem work and visible human prompts without a growing seen
// set. One lifecycle controller cancels polling and the active question; phase
// approvals deliberately have no request deadline because their separate gate
// pauses the execution budget. stop() still waits only for its configured grace
// period and removes the owner directory even when cancellation fails.
// ────────────────────────────────────────────────────────────────
export async function start(directory: string, ask: AskHuman, options: StartOptions = {}): Promise<Bridge> {
  const requestTimeoutMs =
    options.requestTimeoutMs === null
      ? null
      : positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs")
  const stopTimeoutMs = positiveDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs")
  const pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs")
  await mkdir(directory, { recursive: false, mode: 0o700 })
  try {
    await chmod(directory, 0o700)
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "question bridge setup and cleanup failed")
    }
    throw error
  }

  const lifecycle = new AbortController()
  const failures: unknown[] = []
  let omittedFailures = 0
  const retainFailure = (error: unknown) => {
    if (failures.length < MAX_RETAINED_FAILURES) failures.push(error)
    else omittedFailures += 1
  }
  const pump = (async () => {
    while (!lifecycle.signal.aborted) {
      const names = await requestNames(directory, lifecycle.signal)
      for (const name of names) {
        if (lifecycle.signal.aborted) break
        try {
          await processRequest(directory, name, ask, lifecycle.signal, requestTimeoutMs)
        } catch (error) {
          retainFailure(error)
        }
      }
      await sleep(pollIntervalMs, lifecycle.signal)
    }
  })().catch((error) => {
    if (!lifecycle.signal.aborted) retainFailure(error)
  })

  let stopping: Promise<void> | undefined
  return {
    directory,
    stop() {
      return (stopping ??= (async () => {
        lifecycle.abort(new Error("question bridge stopped"))
        try {
          await waitBounded(pump, stopTimeoutMs)
        } catch (error) {
          retainFailure(error)
        } finally {
          try {
            await rm(directory, { recursive: true, force: true })
          } catch (error) {
            retainFailure(error)
          }
        }
        if (omittedFailures > 0)
          failures.push(new Error(`${omittedFailures} additional question bridge failures omitted`))
        if (failures.length > 0) throw new AggregateError(failures, "question bridge cleanup failed")
      })())
    },
  }
}

export * as SubsystemQuestionBridge from "./question-bridge"
