// ── AgentRun-Scoped CAPTCHA Circuit Breaker ─────────────────────────
// Persists independent human challenges by AgentRun, browser profile, tab, and
// origin. The versioned multi-entry document reads the former single-state shape
// as a legacy wildcard owner while new writes retain concurrent tab challenges.
// → cyberful/src/subsystem/gateway/server.ts — enforces and clears actor scopes.
// ────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserProfile, type BrowserProfileId } from "@/dependency/browser-profile"
import { isRecord } from "@/util/record"

const FILE_VERSION = 2
const MAX_ENTRIES = 256
const mutationQueues = new Map<string, Promise<void>>()

export type CircuitBreakerStatus = "awaiting_human" | "awaiting_verification" | "cleared"

export interface CircuitScope {
  readonly ownerRunID: string
  readonly profile: BrowserProfileId
  readonly origin: string
  readonly pageID: string
}

export interface CircuitBreakerState extends Omit<CircuitScope, "ownerRunID"> {
  readonly ownerRunID?: string
  readonly kind: "captcha"
  readonly status: CircuitBreakerStatus
  readonly phase: string
  readonly activatedAt: number
  readonly updatedAt: number
  readonly surfacedAt?: number
}

export type CircuitBreakerIdentity = CircuitBreakerState

interface CircuitBreakerDocument {
  readonly version: typeof FILE_VERSION
  readonly entries: readonly CircuitBreakerState[]
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function validScope(input: Record<string, unknown>) {
  return (
    BrowserProfile.isBrowserProfileId(input.profile) &&
    typeof input.origin === "string" &&
    input.origin.length > 0 &&
    typeof input.pageID === "string" &&
    input.pageID.length > 0 &&
    (input.ownerRunID === undefined || (typeof input.ownerRunID === "string" && input.ownerRunID.length > 0))
  )
}

function decodeState(input: unknown): CircuitBreakerState | undefined {
  if (!isRecord(input) || input.kind !== "captcha" || !validScope(input)) return
  if (input.status !== "awaiting_human" && input.status !== "awaiting_verification" && input.status !== "cleared") return
  if (typeof input.phase !== "string" || !input.phase) return
  if (typeof input.activatedAt !== "number" || !Number.isFinite(input.activatedAt) || input.activatedAt < 0) return
  if (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) return
  if (
    input.surfacedAt !== undefined &&
    (typeof input.surfacedAt !== "number" || !Number.isFinite(input.surfacedAt) || input.surfacedAt < 0)
  )
    return
  return input as unknown as CircuitBreakerState
}

function decodeDocument(input: unknown): CircuitBreakerDocument | undefined {
  const legacy = decodeState(input)
  if (legacy) return { version: FILE_VERSION, entries: [legacy] }
  if (!isRecord(input) || input.version !== FILE_VERSION || !Array.isArray(input.entries)) return
  const entries = input.entries.map(decodeState)
  if (entries.some((entry) => entry === undefined)) return
  return { version: FILE_VERSION, entries: entries as CircuitBreakerState[] }
}

async function readDocument(filePath: string): Promise<CircuitBreakerDocument> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (isMissing(error)) return { version: FILE_VERSION, entries: [] }
    throw error
  }
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    throw new Error("CAPTCHA circuit breaker contains invalid JSON", { cause: error })
  }
  const document = decodeDocument(input)
  if (!document) throw new Error("CAPTCHA circuit breaker contains invalid state")
  return document
}

export async function readCircuitBreakers(filePath: string): Promise<readonly CircuitBreakerState[]> {
  return (await readDocument(filePath)).entries
}

export async function readCircuitBreaker(filePath: string): Promise<CircuitBreakerState | undefined> {
  return [...(await readCircuitBreakers(filePath))].toSorted((left, right) => right.updatedAt - left.updatedAt)[0]
}

export async function readActorCircuitBreaker(filePath: string, ownerRunID: string) {
  return [...(await readCircuitBreakers(filePath))]
    .filter((state) => state.status !== "cleared" && (!state.ownerRunID || state.ownerRunID === ownerRunID))
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0]
}

export async function activateCircuitBreaker(filePath: string, phase: string, scope: CircuitScope, surfaced = false) {
  return mutate(filePath, async () => {
  const document = await readDocument(filePath)
  const current = document.entries.find((state) => state.status !== "cleared" && sameScope(state, scope))
  if (current) {
    if (!surfaced || current.surfacedAt) return current
    const state = { ...current, surfacedAt: Date.now(), updatedAt: Date.now() }
    await replace(filePath, document, current, state)
    return state
  }
  const latestActivation = document.entries.reduce((latest, state) => Math.max(latest, state.activatedAt), -1)
  const now = Math.max(Date.now(), latestActivation + 1)
  const state: CircuitBreakerState = {
    kind: "captcha",
    status: "awaiting_human",
    phase,
    ...scope,
    activatedAt: now,
    updatedAt: now,
    ...(surfaced ? { surfacedAt: now } : {}),
  }
  const retained = document.entries.filter((entry) => !sameScope(entry, scope))
  await publish(filePath, compact([...retained, state]))
  return state
  })
}

export async function acknowledgeCircuitBreaker(filePath: string, expected: CircuitBreakerIdentity) {
  return updateExpected(filePath, expected, (current) => ({
    ...current,
    status: "awaiting_verification",
    updatedAt: Date.now(),
  }))
}

export async function dismissCircuitBreaker(filePath: string, expected: CircuitBreakerIdentity) {
  return updateExpected(filePath, expected, (current) => ({
    ...current,
    status: "cleared",
    updatedAt: Date.now(),
  }))
}

export async function clearCircuitBreaker(filePath: string, scope: CircuitScope) {
  return mutate(filePath, async () => {
    const document = await readDocument(filePath)
    const current = document.entries.find((state) => state.status !== "cleared" && sameScope(state, scope))
    if (!current) return false
    await replace(filePath, document, current, { ...current, status: "cleared", updatedAt: Date.now() })
    return true
  })
}

export async function circuitBreakerError(filePath: string, tool: string, scope?: CircuitScope) {
  if (
    (tool !== "web_search" && !tool.startsWith("browser_")) ||
    tool === "browser_captcha_status" ||
    tool === "browser_captcha_handoff"
  )
    return
  if (!scope) return
  const current = (await readCircuitBreakers(filePath)).find(
    (state) => state.status !== "cleared" && sameScope(state, scope),
  )
  if (!current) return
  return `CAPTCHA awaits human resolution for this AgentRun tab on browser profile ${current.profile} at ${current.origin}. Other AgentRuns, tabs, profiles, and origins remain available.`
}

function sameScope(left: CircuitBreakerState, right: CircuitScope) {
  return (
    (!left.ownerRunID || left.ownerRunID === right.ownerRunID) &&
    left.profile === right.profile &&
    left.origin === right.origin &&
    left.pageID === right.pageID
  )
}

function sameActivation(left: CircuitBreakerState, right: CircuitBreakerIdentity) {
  return (
    left.activatedAt === right.activatedAt &&
    left.profile === right.profile &&
    left.origin === right.origin &&
    left.pageID === right.pageID &&
    left.ownerRunID === right.ownerRunID
  )
}

async function updateExpected(
  filePath: string,
  expected: CircuitBreakerIdentity,
  update: (current: CircuitBreakerState) => CircuitBreakerState,
) {
  return mutate(filePath, async () => {
    const document = await readDocument(filePath)
    const current = document.entries.find((state) => state.status !== "cleared" && sameActivation(state, expected))
    if (!current) return false
    await replace(filePath, document, current, update(current))
    return true
  })
}

async function mutate<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(() => undefined, () => undefined)
  mutationQueues.set(filePath, settled)
  try {
    return await result
  } finally {
    if (mutationQueues.get(filePath) === settled) mutationQueues.delete(filePath)
  }
}

async function replace(
  filePath: string,
  document: CircuitBreakerDocument,
  current: CircuitBreakerState,
  next: CircuitBreakerState,
) {
  await publish(
    filePath,
    document.entries.map((entry) => (sameActivation(entry, current) ? next : entry)),
  )
}

function compact(entries: readonly CircuitBreakerState[]) {
  if (entries.length <= MAX_ENTRIES) return entries
  return [...entries]
    .toSorted((left, right) => {
      if ((left.status === "cleared") !== (right.status === "cleared")) return left.status === "cleared" ? 1 : -1
      return right.updatedAt - left.updatedAt
    })
    .slice(0, MAX_ENTRIES)
}

async function publish(filePath: string, entries: readonly CircuitBreakerState[]) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: FILE_VERSION, entries: compact(entries) }), {
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, filePath)
}
