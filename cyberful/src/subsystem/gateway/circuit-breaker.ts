// ── Engagement CAPTCHA Circuit Breaker ──────────────────────────
// Atomically persists CAPTCHA intervention state across phase gateways and blocks
// active browser or proxy tools until the host acknowledges and verifies clearance.
// → cyberful/src/subsystem/gateway/server.ts — enforces the decision for tool calls.
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@/util/record"

export type CircuitBreakerStatus = "awaiting_human" | "awaiting_verification" | "cleared"

export interface CircuitBreakerState {
  kind: "captcha"
  status: CircuitBreakerStatus
  phase: string
  activatedAt: number
  updatedAt: number
  surfacedAt?: number
}

const allowedWhileOpen = new Set([
  "browser_captcha_status",
  "browser_captcha_handoff",
  "browser_snapshot",
  "browser_network_log",
  "zap_history_search",
  "zap_history_get",
])

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function decodeState(input: unknown): CircuitBreakerState | undefined {
  if (!isRecord(input)) return
  if (input.kind !== "captcha") return
  if (input.status !== "awaiting_human" && input.status !== "awaiting_verification" && input.status !== "cleared")
    return
  if (typeof input.phase !== "string" || input.phase.length === 0) return
  if (typeof input.activatedAt !== "number" || !Number.isFinite(input.activatedAt) || input.activatedAt < 0) return
  if (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) return
  if (
    input.surfacedAt !== undefined &&
    (typeof input.surfacedAt !== "number" || !Number.isFinite(input.surfacedAt) || input.surfacedAt < 0)
  )
    return
  return {
    kind: input.kind,
    status: input.status,
    phase: input.phase,
    activatedAt: input.activatedAt,
    updatedAt: input.updatedAt,
    ...(input.surfacedAt === undefined ? {} : { surfacedAt: input.surfacedAt }),
  }
}

export async function readCircuitBreaker(filePath: string): Promise<CircuitBreakerState | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    throw new Error("CAPTCHA circuit breaker contains invalid JSON", { cause: error })
  }
  const state = decodeState(input)
  if (!state) throw new Error("CAPTCHA circuit breaker contains invalid state")
  return state
}

export async function activateCircuitBreaker(filePath: string, phase: string, surfaced = false) {
  const current = await readCircuitBreaker(filePath)
  if (current && current.status !== "cleared") {
    if (!surfaced || current.surfacedAt) return current
    const state = { ...current, surfacedAt: Date.now(), updatedAt: Date.now() }
    await publish(filePath, state)
    return state
  }
  const now = Date.now()
  const state: CircuitBreakerState = {
    kind: "captcha",
    status: "awaiting_human",
    phase,
    activatedAt: now,
    updatedAt: now,
    ...(surfaced ? { surfacedAt: now } : {}),
  }
  await publish(filePath, state)
  return state
}

export async function acknowledgeCircuitBreaker(filePath: string) {
  const current = await readCircuitBreaker(filePath)
  if (!current || current.status === "cleared") return current
  const state = { ...current, status: "awaiting_verification" as const, updatedAt: Date.now() }
  await publish(filePath, state)
  return state
}

export async function clearCircuitBreaker(filePath: string) {
  const current = await readCircuitBreaker(filePath)
  if (!current) return
  await publish(filePath, { ...current, status: "cleared", updatedAt: Date.now() })
}

export async function circuitBreakerError(filePath: string, tool: string) {
  if (allowedWhileOpen.has(tool)) return
  const files = await readdir(path.dirname(filePath)).catch((error: unknown) => {
    if (isMissing(error)) return []
    throw error
  })
  const current = (
    await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map((name) => readCircuitBreaker(path.join(path.dirname(filePath), name))),
    )
  ).find((state) => state && state.status !== "cleared")
  if (!current) return
  return (
    `The CAPTCHA circuit breaker is ${current.status.replaceAll("_", " ")}. ` +
    "Do not resume active tooling. Resolve the visible challenge through a kind=captcha question, then call " +
    "browser_captcha_status; only a host-observed clear status releases this breaker."
  )
}

async function publish(filePath: string, value: CircuitBreakerState) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
  await rename(temporary, filePath)
}
