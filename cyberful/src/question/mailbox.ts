// ── Durable Approval Mailbox ─────────────────────────────────────
// Publishes owner-only pending questions and accepts one atomically validated
//   decision from the TUI, CLI, or a remote Codex task on the same host.
// → cyberful/src/question/index.ts — waits on mailbox decisions for live requests.
// → cyberful/src/cli/cmd/approval.ts — exposes the external selector interface.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, opendir, rm } from "node:fs/promises"
import { Context, Layer } from "effect"
import { Global } from "@/global"
import { isRecord } from "@/util/record"

const DIRECTORY = "approvals"
const REQUEST_SUFFIX = ".request.json"
const RESPONSE_SUFFIX = ".response.json"
const MAX_FILE_BYTES = 64 * 1024
const MAX_DIRECTORY_ENTRIES = 2_048
const DEFAULT_POLL_INTERVAL_MS = 100

export interface Question {
  question: string
  header: string
  options: ReadonlyArray<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export interface Request {
  version: 1
  id: string
  sessionID: string
  questions: ReadonlyArray<Question>
  createdAt: number
  ownerPID: number
}

export type Decision =
  | { status: "answered"; answers: ReadonlyArray<ReadonlyArray<string>>; decidedAt: number }
  | { status: "rejected"; decidedAt: number }

export interface PendingRequest extends Request {
  active: boolean
}

export interface Interface {
  readonly publish: (request: Request) => Promise<void>
  readonly answer: (requestID: string, answers: ReadonlyArray<ReadonlyArray<string>>) => Promise<void>
  readonly reject: (requestID: string) => Promise<void>
  readonly wait: (requestID: string, signal: AbortSignal) => Promise<Decision>
  readonly list: () => Promise<ReadonlyArray<PendingRequest>>
  readonly read: (requestID: string) => Promise<PendingRequest>
  readonly remove: (requestID: string) => Promise<void>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/ApprovalMailbox") {}

function safeRequestID(requestID: string): string {
  if (!/^que[a-zA-Z0-9_-]+$/.test(requestID)) throw new Error("approval request ID is invalid")
  return requestID
}

function directory(root: string) {
  return path.join(root, DIRECTORY)
}

function requestPath(root: string, requestID: string) {
  return path.join(directory(root), `${safeRequestID(requestID)}${REQUEST_SUFFIX}`)
}

function responsePath(root: string, requestID: string) {
  return path.join(directory(root), `${safeRequestID(requestID)}${RESPONSE_SUFFIX}`)
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function parseQuestion(input: unknown): Question | undefined {
  if (!isRecord(input)) return
  if (!boundedString(input.question, 8_000) || !boundedString(input.header, 30) || !Array.isArray(input.options)) return
  if (input.options.length > 20) return
  const options = input.options.flatMap((option) =>
    isRecord(option) && boundedString(option.label, 200) && boundedString(option.description, 2_000)
      ? [{ label: option.label, description: option.description }]
      : [],
  )
  if (options.length !== input.options.length) return
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

function parseRequest(input: unknown): Request {
  if (!isRecord(input) || input.version !== 1) throw new Error("approval request has an invalid envelope")
  if (!boundedString(input.id, 128) || !boundedString(input.sessionID, 256))
    throw new Error("approval request has an invalid identity")
  safeRequestID(input.id)
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 3)
    throw new Error("approval request has an invalid question count")
  const questions = input.questions.flatMap((question) => {
    const parsed = parseQuestion(question)
    return parsed ? [parsed] : []
  })
  if (questions.length !== input.questions.length) throw new Error("approval request contains an invalid question")
  if (
    typeof input.createdAt !== "number" ||
    !Number.isSafeInteger(input.createdAt) ||
    typeof input.ownerPID !== "number" ||
    !Number.isSafeInteger(input.ownerPID)
  )
    throw new Error("approval request has invalid process metadata")
  return {
    version: 1,
    id: input.id,
    sessionID: input.sessionID,
    questions,
    createdAt: input.createdAt,
    ownerPID: input.ownerPID,
  }
}

function parseDecision(input: unknown): Decision {
  if (!isRecord(input) || !Number.isSafeInteger(input.decidedAt))
    throw new Error("approval response has an invalid envelope")
  if (input.status === "rejected") return { status: "rejected", decidedAt: input.decidedAt as number }
  if (input.status !== "answered" || !Array.isArray(input.answers))
    throw new Error("approval response has an invalid decision")
  const answers: string[][] = []
  for (const answer of input.answers) {
    if (!Array.isArray(answer) || answer.length > 20 || !answer.every((value) => boundedString(value, 8_000)))
      throw new Error("approval response contains an invalid answer")
    answers.push([...answer])
  }
  return { status: "answered", answers, decidedAt: input.decidedAt as number }
}

async function readBounded(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error("approval mailbox file is invalid")
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

async function writeExclusive(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("approval mailbox value exceeds 64 KiB")
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(serialized, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function processActive(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function validateAnswers(request: Request, answers: ReadonlyArray<ReadonlyArray<string>>): string[][] {
  if (answers.length !== request.questions.length) throw new Error("one answer set is required for every question")
  return answers.map((answer, index) => {
    const question = request.questions[index]
    if (!question) throw new Error("approval question is missing")
    if (answer.length < 1) throw new Error(`question ${index + 1} requires an answer`)
    if (question.multiple !== true && answer.length !== 1)
      throw new Error(`question ${index + 1} accepts exactly one answer`)
    if (answer.length > 20) throw new Error(`question ${index + 1} has too many answers`)
    return answer.map((value) => {
      if (!boundedString(value, 8_000)) throw new Error(`question ${index + 1} contains an invalid answer`)
      const known = question.options.some((option) => option.label === value)
      if (!known && question.custom === false)
        throw new Error(`'${value}' is not an allowed choice for question ${index + 1}`)
      return value
    })
  })
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("approval wait was aborted")
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal)
  await new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(complete, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", abort, { once: true })
    timer.unref?.()
  })
}

// ── A Decision Is Bound To One Live Request Envelope ─────────────
// The immutable request file fixes session, owner process, questions, and exact
// options before any external actor can answer. A separate exclusive response
// file makes the first valid reply authoritative across TUI and CLI processes.
// Dead owners remain inspectable but cannot accept a late answer, preventing a
// stale mobile selection from authorizing a later run that reused no context.
// ─────────────────────────────────────────────────────────────────
export function make(root: string): Interface {
  const ensureDirectory = async () => {
    await mkdir(directory(root), { recursive: true, mode: 0o700 })
    const metadata = await lstat(directory(root))
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("approval mailbox directory is invalid")
    if (process.platform !== "win32") await chmod(directory(root), 0o700)
  }

  const read = async (requestID: string): Promise<PendingRequest> => {
    const request = parseRequest(JSON.parse(await readBounded(requestPath(root, requestID))))
    return { ...request, active: processActive(request.ownerPID) }
  }

  const publish = async (request: Request) => {
    await ensureDirectory()
    try {
      await readBounded(responsePath(root, request.id))
      throw new Error("approval request ID was already resolved")
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    await writeExclusive(requestPath(root, request.id), request)
  }

  const decide = async (requestID: string, decision: Decision) => {
    const request = await read(requestID)
    if (!request.active) throw new Error("approval request owner is no longer running")
    await writeExclusive(responsePath(root, requestID), decision).catch((error) => {
      if (errorCode(error) === "EEXIST") throw new Error("approval request was already resolved", { cause: error })
      throw error
    })
  }

  const answer = async (requestID: string, answers: ReadonlyArray<ReadonlyArray<string>>) => {
    const request = await read(requestID)
    await decide(requestID, {
      status: "answered",
      answers: validateAnswers(request, answers),
      decidedAt: Date.now(),
    })
  }

  const reject = (requestID: string) => decide(requestID, { status: "rejected", decidedAt: Date.now() })

  const wait = async (requestID: string, signal: AbortSignal) => {
    while (true) {
      if (signal.aborted) throw abortError(signal)
      try {
        return parseDecision(JSON.parse(await readBounded(responsePath(root, requestID))))
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
      await delay(DEFAULT_POLL_INTERVAL_MS, signal)
    }
  }

  const list = async () => {
    await ensureDirectory()
    const entries: string[] = []
    const handle = await opendir(directory(root))
    try {
      for await (const entry of handle) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) break
        if (entry.isFile() && entry.name.endsWith(REQUEST_SUFFIX)) entries.push(entry.name)
      }
    } finally {
      try {
        await handle.close()
      } catch (error) {
        if (errorCode(error) !== "ERR_DIR_CLOSED") throw error
      }
    }
    const pending = await Promise.all(
      entries.map(async (name) => {
        const requestID = name.slice(0, -REQUEST_SUFFIX.length)
        try {
          await readBounded(responsePath(root, requestID))
          return
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error
        }
        return read(requestID)
      }),
    )
    return pending.filter((request): request is PendingRequest => request !== undefined)
  }

  const remove = async (requestID: string) => {
    await Promise.all([
      rm(requestPath(root, requestID), { force: true }),
      rm(responsePath(root, requestID), { force: true }),
    ])
  }

  return { publish, answer, reject, wait, list, read, remove }
}

export const layer = (root: string) => Layer.succeed(Service, Service.of(make(root)))
export const defaultLayer = layer(Global.Path.state)

export * as ApprovalMailbox from "./mailbox"
