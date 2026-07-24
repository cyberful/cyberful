// ── TUI Terminal Cleanup Regression Tests ────────────────────────
// Verifies that closing the TUI awaits the full run-owned Docker cleanup window
//   after a worker timeout and retains synchronous retries for degraded cleanup.
// → cyberful/src/cli/cmd/tui/thread-cleanup.ts — owns the tested fallback.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { cleanupAfterWorker, type CleanupAfterWorkerDeps } from "./thread-cleanup"

describe("TUI terminal cleanup", () => {
  test("awaits run-owned container removal before process-exit retries", async () => {
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const events: string[] = []
    const deps: CleanupAfterWorkerDeps = {
      info: (message) => events.push(message),
      killTree: (pid) => events.push(`kill:${pid}`),
      removeRunOwned: async (runID) => {
        events.push(`awaited:${runID}:start`)
        started.resolve()
        await release.promise
        events.push(`awaited:${runID}:complete`)
      },
      reapSnapshotSync: (resources) => {
        events.push(`snapshot:${[...resources].map((item) => item.name).join(",")}`)
        return true
      },
      reapRunOwnedSync: (runID) => {
        events.push(`sync:${runID}`)
        return true
      },
      warn: () => events.push("warn"),
    }

    const cleanup = cleanupAfterWorker(
      {
        runID: "run-alpha",
        pids: [101],
        resources: [{ name: "cyberful-os-expert-alpha", action: "remove", kind: "expert" }],
      },
      deps,
    )
    await started.promise

    expect(events).toEqual(["terminal container cleanup started", "kill:101", "awaited:run-alpha:start"])

    release.resolve()
    await cleanup

    expect(events).toEqual([
      "terminal container cleanup started",
      "kill:101",
      "awaited:run-alpha:start",
      "awaited:run-alpha:complete",
      "snapshot:cyberful-os-expert-alpha",
      "sync:run-alpha",
      "terminal container cleanup completed",
    ])
  })

  test("runs both synchronous retries when awaited cleanup fails", async () => {
    const events: string[] = []
    const failure = new Error("Docker cleanup timed out")
    const deps: CleanupAfterWorkerDeps = {
      info: (message) => events.push(message),
      killTree: () => {},
      removeRunOwned: async () => {
        throw failure
      },
      reapSnapshotSync: () => {
        events.push("snapshot")
        return true
      },
      reapRunOwnedSync: () => {
        events.push("label-sweep")
        return true
      },
      warn: (message, error) => {
        expect(message).toBe("terminal container cleanup failed")
        expect(error).toBe(failure)
        events.push("warn")
      },
    }

    await cleanupAfterWorker({ runID: "run-alpha", pids: [], resources: [] }, deps)

    expect(events).toEqual([
      "terminal container cleanup started",
      "snapshot",
      "label-sweep",
      "warn",
    ])
  })

  test("reports synchronous fallback failures instead of claiming cleanup completed", async () => {
    const events: string[] = []
    const deps: CleanupAfterWorkerDeps = {
      info: (message) => events.push(message),
      killTree: () => {},
      removeRunOwned: async () => {},
      reapSnapshotSync: () => false,
      reapRunOwnedSync: () => true,
      warn: (message) => events.push(message),
    }

    await cleanupAfterWorker({ runID: "run-alpha", pids: [], resources: [] }, deps)

    expect(events).toEqual(["terminal container cleanup started", "terminal container cleanup failed"])
  })
})
