// ── Scoped CAPTCHA Circuit Breaker ──────────────────────────────
// Persists a human challenge for one browser profile and origin while unrelated
//   profiles, origins, tabs, proxy calls, and other tools continue normally.
// → cyberful/src/subsystem/gateway/server.ts — enforces and clears the scope.
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserProfile, type BrowserProfileId } from "@/dependency/browser-profile"
import { isRecord } from "@/util/record"

export type CircuitBreakerStatus = "awaiting_human" | "awaiting_verification" | "cleared"

export interface CircuitScope {
  readonly profile: BrowserProfileId
  readonly origin: string
  readonly pageID: string
}

export interface CircuitBreakerState extends CircuitScope {
  readonly kind: "captcha"
  readonly status: CircuitBreakerStatus
  readonly phase: string
  readonly activatedAt: number
  readonly updatedAt: number
  readonly surfacedAt?: number
}

export type CircuitBreakerIdentity = CircuitScope & Pick<CircuitBreakerState, "activatedAt">

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function validScope(input: Record<string, unknown>) {
  return BrowserProfile.isBrowserProfileId(input.profile) &&
    typeof input.origin === "string" && input.origin.length > 0 && typeof input.pageID === "string" && input.pageID.length > 0
}

function decodeState(input: unknown): CircuitBreakerState | undefined {
  if (!isRecord(input) || input.kind !== "captcha" || !validScope(input)) return
  if (input.status !== "awaiting_human" && input.status !== "awaiting_verification" && input.status !== "cleared") return
  if (typeof input.phase !== "string" || !input.phase) return
  if (typeof input.activatedAt !== "number" || !Number.isFinite(input.activatedAt) || input.activatedAt < 0) return
  if (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) return
  if (input.surfacedAt !== undefined && (typeof input.surfacedAt !== "number" || !Number.isFinite(input.surfacedAt) || input.surfacedAt < 0)) return
  return input as unknown as CircuitBreakerState
}

export async function readCircuitBreaker(filePath: string): Promise<CircuitBreakerState | undefined> {
  let raw: string
  try { raw = await readFile(filePath, "utf8") } catch (error) { if (isMissing(error)) return; throw error }
  let input: unknown
  try { input = JSON.parse(raw) } catch (error) { throw new Error("CAPTCHA circuit breaker contains invalid JSON", { cause: error }) }
  const state = decodeState(input)
  if (!state) throw new Error("CAPTCHA circuit breaker contains invalid state")
  return state
}

export async function activateCircuitBreaker(filePath: string, phase: string, scope: CircuitScope, surfaced = false) {
  const current = await readCircuitBreaker(filePath)
  if (current && current.status !== "cleared" && sameScope(current, scope)) {
    if (!surfaced || current.surfacedAt) return current
    const state = { ...current, surfacedAt: Date.now(), updatedAt: Date.now() }
    await publish(filePath, state)
    return state
  }
  const now = Math.max(Date.now(), (current?.activatedAt ?? -1) + 1)
  const state: CircuitBreakerState = {
    kind: "captcha",
    status: "awaiting_human",
    phase,
    ...scope,
    activatedAt: now,
    updatedAt: now,
    ...(surfaced ? { surfacedAt: now } : {}),
  }
  await publish(filePath, state)
  return state
}

export async function acknowledgeCircuitBreaker(filePath: string, expected: CircuitBreakerIdentity) {
  const current = await readCircuitBreaker(filePath)
  if (!current || current.status === "cleared" || !sameActivation(current, expected)) return false
  const state = { ...current, status: "awaiting_verification" as const, updatedAt: Date.now() }
  await publish(filePath, state)
  return true
}

export async function dismissCircuitBreaker(filePath: string, expected: CircuitBreakerIdentity) {
  const current = await readCircuitBreaker(filePath)
  if (!current || current.status === "cleared" || !sameActivation(current, expected)) return false
  await publish(filePath, { ...current, status: "cleared", updatedAt: Date.now() })
  return true
}

export async function clearCircuitBreaker(filePath: string, scope: CircuitScope) {
  const current = await readCircuitBreaker(filePath)
  if (!current || current.status === "cleared" || !sameScope(current, scope)) return false
  await publish(filePath, { ...current, status: "cleared", updatedAt: Date.now() })
  return true
}

export async function circuitBreakerError(filePath: string, tool: string, scope?: CircuitScope) {
  if (
    (tool !== "web_search" && !tool.startsWith("browser_")) ||
    tool === "browser_captcha_status" ||
    tool === "browser_captcha_handoff"
  )
    return
  const current = await readCircuitBreaker(filePath)
  if (!current || current.status === "cleared" || !scope || !sameProfileOrigin(current, scope)) return
  return `CAPTCHA awaits human resolution for browser profile ${current.profile} at ${current.origin}. Other browser profiles and origins remain available.`
}

function sameProfileOrigin(left: CircuitScope, right: CircuitScope) {
  return left.profile === right.profile && left.origin === right.origin
}

function sameScope(left: CircuitScope, right: CircuitScope) {
  return sameProfileOrigin(left, right) && left.pageID === right.pageID
}

function sameActivation(left: CircuitBreakerState, right: CircuitBreakerIdentity) {
  return left.activatedAt === right.activatedAt && sameScope(left, right)
}

async function publish(filePath: string, value: CircuitBreakerState) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
  await rename(temporary, filePath)
}
