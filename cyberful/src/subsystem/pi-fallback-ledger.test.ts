// ── Durable Pi Fallback Ledger Tests ─────────────────────────────
// Verifies session quota survives worker/process replacement, remains private,
// rejects symlink storage, and is removed with the owning session.
// → cyberful/src/subsystem/pi-fallback-ledger.ts — owns persistence.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  clearFallbackLedger,
  deleteDurableFallbackLedger,
  durableFallbackLedgerForSession,
} from "./pi-fallback-ledger"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-fallback-ledger-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable fallback quota ledger", () => {
  test.each([
    [49, 1],
    [50, 2],
    [99, 2],
    [100, 3],
  ] as const)("applies the deterministic 2%% + 1 boundary at %i main actors", async (actors, expected) => {
    const root = await temporaryRoot()
    const sessionID = `ses_boundary_${actors}`
    const ledger = await durableFallbackLedgerForSession(sessionID, root)
    for (let index = 0; index < actors; index++) await ledger.recordMainActor()

    const admissions = []
    for (let index = 0; index < expected + 1; index++) admissions.push(await ledger.tryAdmitProactive(2))

    expect(admissions.filter((admission) => admission.admitted)).toHaveLength(expected)
    expect(admissions.at(-1)?.admitted).toBe(false)
    expect(admissions.at(-1)?.limit).toBe(expected)
    clearFallbackLedger(sessionID)
  })

  test("persists session counters across independent phase-worker loads", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_durable_fallback"
    const first = await durableFallbackLedgerForSession(sessionID, root)
    await first.recordMainActor()
    await first.tryAdmitProactive(2)
    clearFallbackLedger(sessionID)

    const second = await durableFallbackLedgerForSession(sessionID, root)

    expect(second).not.toBe(first)
    expect(second.mainActorRuns).toBe(1)
    expect(second.proactiveAdmissions).toBe(1)
    const entries = (await readdir(root)).filter((entry) => entry.endsWith(".json"))
    expect(entries).toHaveLength(1)
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      expect((await lstat(path.join(root, entries[0]!))).mode & 0o777).toBe(0o600)
    }
  })

  test("loads a v1 primary counter and rewrites it as a v2 main counter", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_legacy_fallback"
    const file = path.join(root, `${createHash("sha256").update(sessionID).digest("hex")}.json`)
    await writeFile(
      file,
      `${JSON.stringify({
        version: 1,
        sessionID,
        primaryActorRuns: 3,
        proactiveAdmissions: 1,
      })}\n`,
      { mode: 0o600 },
    )

    const ledger = await durableFallbackLedgerForSession(sessionID, root)
    expect(ledger.mainActorRuns).toBe(3)
    await ledger.recordMainActor()

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 2,
      sessionID,
      mainActorRuns: 4,
      proactiveAdmissions: 1,
    })
  })

  test("deletes the durable state with its session", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_deleted_fallback"
    const ledger = await durableFallbackLedgerForSession(sessionID, root)
    await ledger.recordMainActor()

    await deleteDurableFallbackLedger(sessionID, root)
    clearFallbackLedger(sessionID)
    const replacement = await durableFallbackLedgerForSession(sessionID, root)

    expect(replacement.mainActorRuns).toBe(0)
    expect(replacement.proactiveAdmissions).toBe(0)
  })

  test("admits atomically across independent process-style ledger owners", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_atomic_fallback"
    const first = await durableFallbackLedgerForSession(sessionID, root)
    await first.recordMainActor()
    clearFallbackLedger(sessionID)
    const second = await durableFallbackLedgerForSession(sessionID, root)

    const admissions = await Promise.all([
      first.tryAdmitProactive(2),
      second.tryAdmitProactive(2),
    ])

    expect(admissions.filter((admission) => admission.admitted)).toHaveLength(1)
    clearFallbackLedger(sessionID)
    const stored = await durableFallbackLedgerForSession(sessionID, root)
    expect(stored.mainActorRuns).toBe(1)
    expect(stored.proactiveAdmissions).toBe(1)
  })

  test("refuses a symlinked ledger root", async () => {
    const parent = await temporaryRoot()
    const real = path.join(parent, "real")
    const linked = path.join(parent, "linked")
    await mkdir(real)
    await symlink(real, linked)

    await expect(durableFallbackLedgerForSession("ses_symlink", linked)).rejects.toThrow(
      "non-symlink directory",
    )
    clearFallbackLedger("ses_symlink")
  })
})
