// ── Durable Pi Fallback Ledger Tests ─────────────────────────────
// Verifies session quota survives worker/process replacement, remains private,
// rejects symlink storage, and is removed with the owning session.
// → cyberful/src/subsystem/pi-fallback-ledger.ts — owns persistence.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises"
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
  test("persists session counters across independent phase-worker loads", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_durable_fallback"
    const first = await durableFallbackLedgerForSession(sessionID, root)
    await first.recordPrimaryActor()
    await first.tryAdmitProactive(2)
    clearFallbackLedger(sessionID)

    const second = await durableFallbackLedgerForSession(sessionID, root)

    expect(second).not.toBe(first)
    expect(second.primaryActorRuns).toBe(1)
    expect(second.proactiveAdmissions).toBe(1)
    const entries = (await readdir(root)).filter((entry) => entry.endsWith(".json"))
    expect(entries).toHaveLength(1)
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      expect((await lstat(path.join(root, entries[0]!))).mode & 0o777).toBe(0o600)
    }
  })

  test("deletes the durable state with its session", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_deleted_fallback"
    const ledger = await durableFallbackLedgerForSession(sessionID, root)
    await ledger.recordPrimaryActor()

    await deleteDurableFallbackLedger(sessionID, root)
    clearFallbackLedger(sessionID)
    const replacement = await durableFallbackLedgerForSession(sessionID, root)

    expect(replacement.primaryActorRuns).toBe(0)
    expect(replacement.proactiveAdmissions).toBe(0)
  })

  test("admits atomically across independent process-style ledger owners", async () => {
    const root = await temporaryRoot()
    const sessionID = "ses_atomic_fallback"
    const first = await durableFallbackLedgerForSession(sessionID, root)
    await first.recordPrimaryActor()
    clearFallbackLedger(sessionID)
    const second = await durableFallbackLedgerForSession(sessionID, root)

    const admissions = await Promise.all([
      first.tryAdmitProactive(2),
      second.tryAdmitProactive(2),
    ])

    expect(admissions.filter((admission) => admission.admitted)).toHaveLength(1)
    clearFallbackLedger(sessionID)
    const stored = await durableFallbackLedgerForSession(sessionID, root)
    expect(stored.primaryActorRuns).toBe(1)
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
