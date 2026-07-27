// ── Durable Pi Fallback Admission Ledger ─────────────────────────
// Persists session-wide proactive fallback quota across sequential phase
// workers and process restarts without placing host policy inside a workarea.
// → cyberful/src/subsystem/pi-agent.ts — accounts primary actors and admissions.
// → cyberful/src/session/session.ts — removes the ledger with its session.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { Global } from "@/global"
import { Flock } from "@/util/flock"
import { isRecord } from "@/util/record"

const VERSION = 1

export interface PiFallbackLedger {
  readonly sessionID: string
  readonly primaryActorRuns: number
  readonly proactiveAdmissions: number
  recordPrimaryActor(): Promise<PiFallbackLedgerSnapshot>
  tryAdmitProactive(percentage: number): Promise<PiFallbackAdmission>
  rollbackProactiveAdmission(): Promise<PiFallbackLedgerSnapshot>
}

export interface PiFallbackLedgerSnapshot {
  readonly primaryActorRuns: number
  readonly proactiveAdmissions: number
}

export interface PiFallbackAdmission extends PiFallbackLedgerSnapshot {
  readonly admitted: boolean
  readonly limit: number
}

interface PersistedLedger {
  readonly version: 1
  readonly sessionID: string
  readonly primaryActorRuns: number
  readonly proactiveAdmissions: number
}

const ledgers = new Map<string, PiFallbackLedger>()
const durableLoads = new Map<string, Promise<PiFallbackLedger>>()
const durableLedgers = new WeakSet<PiFallbackLedger>()

function normalizedSessionID(sessionID: string): string {
  const normalized = sessionID.trim()
  if (!normalized) throw new Error("Fallback quota ledger requires a non-empty session ID")
  return normalized
}

function ledgerFilename(sessionID: string): string {
  return `${createHash("sha256").update(sessionID).digest("hex")}.json`
}

function ledgerPath(sessionID: string, root: string): string {
  return path.join(root, ledgerFilename(sessionID))
}

function decodeLedger(value: unknown, sessionID: string): PersistedLedger {
  if (
    !isRecord(value) ||
    value.version !== VERSION ||
    value.sessionID !== sessionID ||
    !Number.isSafeInteger(value.primaryActorRuns) ||
    Number(value.primaryActorRuns) < 0 ||
    !Number.isSafeInteger(value.proactiveAdmissions) ||
    Number(value.proactiveAdmissions) < 0
  )
    throw new Error(`Fallback quota ledger for session '${sessionID}' is invalid`)
  return {
    version: VERSION,
    sessionID,
    primaryActorRuns: Number(value.primaryActorRuns),
    proactiveAdmissions: Number(value.proactiveAdmissions),
  }
}

async function secureDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const entry = await lstat(root)
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error("Fallback quota ledger root must be a non-symlink directory")
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) await chmod(root, 0o700)
}

async function readPersisted(file: string, sessionID: string): Promise<PersistedLedger | undefined> {
  try {
    const entry = await lstat(file)
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new Error("Fallback quota ledger must be a regular file")
    if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) await chmod(file, 0o600)
    return decodeLedger(JSON.parse(await readFile(file, "utf8")), sessionID)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

async function writePersisted(file: string, ledger: PiFallbackLedger): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.fallback-ledger.${process.pid}.${randomUUID()}.tmp`,
  )
  const value: PersistedLedger = {
    version: VERSION,
    sessionID: ledger.sessionID,
    primaryActorRuns: ledger.primaryActorRuns,
    proactiveAdmissions: ledger.proactiveAdmissions,
  }
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temporary, file)
    if (process.platform !== "win32") await chmod(file, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function snapshot(ledger: PiFallbackLedger): PiFallbackLedgerSnapshot {
  return {
    primaryActorRuns: ledger.primaryActorRuns,
    proactiveAdmissions: ledger.proactiveAdmissions,
  }
}

function proactiveLimit(primaryActorRuns: number, percentage: number): number {
  return Math.floor((primaryActorRuns * percentage) / 100) + 1
}

function memoryLedger(sessionID: string): PiFallbackLedger {
  let primaryActorRuns = 0
  let proactiveAdmissions = 0
  const ledger: PiFallbackLedger = {
    sessionID,
    get primaryActorRuns() {
      return primaryActorRuns
    },
    get proactiveAdmissions() {
      return proactiveAdmissions
    },
    async recordPrimaryActor() {
      primaryActorRuns++
      return snapshot(ledger)
    },
    async tryAdmitProactive(percentage) {
      const limit = proactiveLimit(primaryActorRuns, percentage)
      const admitted = proactiveAdmissions < limit
      if (admitted) proactiveAdmissions++
      return { ...snapshot(ledger), admitted, limit }
    },
    async rollbackProactiveAdmission() {
      proactiveAdmissions = Math.max(0, proactiveAdmissions - 1)
      return snapshot(ledger)
    },
  }
  return ledger
}

export function fallbackLedgerForSession(sessionID: string): PiFallbackLedger {
  const normalized = normalizedSessionID(sessionID)
  const existing = ledgers.get(normalized)
  if (existing) return existing
  const ledger = memoryLedger(normalized)
  ledgers.set(normalized, ledger)
  return ledger
}

// ── One Session Has One Serialized Durable Counter ──────────────
// Phase workers are sequential, but application processes can overlap during
// restart or shutdown. Every production counter operation rereads, validates,
// mutates, and replaces the ledger while holding one filesystem lease. This
// prevents two owners from admitting against the same stale quota snapshot.
// ─────────────────────────────────────────────────────────────────
export function durableFallbackLedgerForSession(
  sessionID: string,
  root = path.join(Global.Path.state, "pi-fallback-ledgers"),
): Promise<PiFallbackLedger> {
  const normalized = normalizedSessionID(sessionID)
  const existing = ledgers.get(normalized)
  if (existing && durableLedgers.has(existing)) return Promise.resolve(existing)
  const loading = durableLoads.get(normalized)
  if (loading) return loading

  const operation = (async () => {
    await secureDirectory(root)
    const file = ledgerPath(normalized, root)
    const stored = await Flock.withLock(
      `pi-fallback-ledger:${file}`,
      () => readPersisted(file, normalized),
      { dir: path.join(root, ".locks") },
    )
    let primaryActorRuns = stored?.primaryActorRuns ?? existing?.primaryActorRuns ?? 0
    let proactiveAdmissions = stored?.proactiveAdmissions ?? existing?.proactiveAdmissions ?? 0
    let ledger: PiFallbackLedger
    const mutate = async <T>(operation: () => T): Promise<T> => {
      await secureDirectory(root)
      return Flock.withLock(
        `pi-fallback-ledger:${file}`,
        async () => {
          const current = await readPersisted(file, normalized)
          if (current) {
            primaryActorRuns = current.primaryActorRuns
            proactiveAdmissions = current.proactiveAdmissions
          }
          const result = operation()
          await writePersisted(file, ledger)
          return result
        },
        { dir: path.join(root, ".locks") },
      )
    }
    ledger = {
      sessionID: normalized,
      get primaryActorRuns() {
        return primaryActorRuns
      },
      get proactiveAdmissions() {
        return proactiveAdmissions
      },
      recordPrimaryActor: () =>
        mutate(() => {
          primaryActorRuns++
          return snapshot(ledger)
        }),
      tryAdmitProactive: (percentage: number) =>
        mutate(() => {
          const limit = proactiveLimit(primaryActorRuns, percentage)
          const admitted = proactiveAdmissions < limit
          if (admitted) proactiveAdmissions++
          return { ...snapshot(ledger), admitted, limit }
        }),
      rollbackProactiveAdmission: () =>
        mutate(() => {
          proactiveAdmissions = Math.max(0, proactiveAdmissions - 1)
          return snapshot(ledger)
        }),
    }
    durableLedgers.add(ledger)
    ledgers.set(normalized, ledger)
    return ledger
  })().finally(() => durableLoads.delete(normalized))
  durableLoads.set(normalized, operation)
  return operation
}

export function clearFallbackLedger(sessionID: string): void {
  const normalized = normalizedSessionID(sessionID)
  durableLoads.delete(normalized)
  ledgers.delete(normalized)
}

export async function deleteDurableFallbackLedger(
  sessionID: string,
  root = path.join(Global.Path.state, "pi-fallback-ledgers"),
): Promise<void> {
  const normalized = normalizedSessionID(sessionID)
  clearFallbackLedger(normalized)
  try {
    const entry = await lstat(root)
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("Fallback quota ledger root must be a non-symlink directory")
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return
    throw error
  }
  const file = ledgerPath(normalized, root)
  await Flock.withLock(`pi-fallback-ledger:${file}`, () => rm(file, { force: true }), {
    dir: path.join(root, ".locks"),
  })
}

export * as SubsystemPiFallbackLedger from "./pi-fallback-ledger"
