// ── Cross-Process Lease Experience Tests ────────────────────────
// Verifies exclusive acquisition, waiting, idempotent release, and timing
// validation used by ordinary workarea and repository-cache writes.
// → cyberful/src/util/flock.ts — owns the lease lifecycle under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Flock } from "./flock"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function lockDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-flock-test-"))
  temporary.push(directory)
  return directory
}

describe("filesystem lease", () => {
  test("keeps a second everyday state writer waiting until the owner releases", async () => {
    const dir = await lockDirectory()
    const timing = { dir, staleMs: 1_000, timeoutMs: 1_000, baseDelayMs: 5, maxDelayMs: 10 }
    const first = await Flock.acquire("shared-state", timing)
    const observedWait = Promise.withResolvers<void>()
    const secondTask = Flock.acquire("shared-state", {
      ...timing,
      onWait: () => {
        observedWait.resolve()
      },
    })

    await observedWait.promise
    await first.release()
    await first.release()
    const second = await secondTask
    await second.release()
  })

  test("rejects timer values that the runtime cannot schedule safely", async () => {
    const dir = await lockDirectory()
    await expect(Flock.acquire("invalid", { dir, timeoutMs: 0 })).rejects.toThrow("timeoutMs")
  })
})
