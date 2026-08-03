// ── Ask Runtime Lifecycle Tests ──────────────────────────────────
// Verifies routine reuse, idle expiry, reacquisition, and terminal cleanup of
// the shared operational runtime used by interactive Ask sessions.
// → cyberful/src/subsystem/ask-runtime.ts — owns the tested runtime manager.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { EngagementRuntime } from "./engagement-runtime"
import { createManager } from "./ask-runtime"

function runtime(stop: () => Promise<void>, env: Record<string, string> = {}): EngagementRuntime {
  return {
    container: "cyberful-runtime",
    env,
    degraded: false,
    warnings: [],
    stop,
  }
}

describe("Ask operational runtime lifecycle", () => {
  test("reuses one runtime, stops it after inactivity, and restarts transparently", async () => {
    let starts = 0
    let stops = 0
    const idleCleanupObserved = Promise.withResolvers<void>()
    const manager = createManager(
      {
        start: async () => {
          starts++
          return runtime(async () => {
            stops++
            idleCleanupObserved.resolve()
          })
        },
      },
      5,
    )
    const input = { sessionID: "ses_ask", workarea: "/tmp/client", objective: "Inspect the report" }

    expect(await manager.acquire(input)).toBe(await manager.acquire(input))
    expect(starts).toBe(1)
    manager.release(input.sessionID)
    await idleCleanupObserved.promise
    expect(stops).toBe(1)

    await manager.acquire(input)
    expect(starts).toBe(2)
    await manager.stopAll()
    expect(stops).toBe(2)
  })

  test("propagates startup failure after the owner performs its own cleanup", async () => {
    const manager = createManager({
      start: async () => {
        throw new Error("runtime failed")
      },
    })

    await expect(
      manager.acquire({ sessionID: "ses_failed", workarea: "/tmp/failure", objective: "Question" }),
    ).rejects.toThrow("runtime failed")
  })

  test("reports an owner cleanup failure", async () => {
    let runtimeStops = 0
    const manager = createManager({
      start: async () =>
        runtime(async () => {
          runtimeStops++
          throw new Error("runtime cleanup failed")
        }),
    })

    await manager.acquire({ sessionID: "ses_cleanup", workarea: "/tmp/cleanup", objective: "Question" })
    await expect(manager.stopAll()).rejects.toThrow("Ask runtime shutdown failed")
    expect(runtimeStops).toBe(1)
  })

  test("joins cleanup already started by idle expiry during shutdown", async () => {
    const cleanupStarted = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    let runtimeStops = 0
    const manager = createManager(
      {
        start: async () =>
          runtime(async () => {
            runtimeStops++
            cleanupStarted.resolve()
            await releaseCleanup.promise
          }),
      },
      1,
    )

    await manager.acquire({ sessionID: "ses_idle", workarea: "/tmp/idle", objective: "Question" })
    manager.release("ses_idle")
    await cleanupStarted.promise

    let shutdownSettled = false
    const shutdown = manager.stopAll().then(() => {
      shutdownSettled = true
    })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    releaseCleanup.resolve()
    await shutdown
    expect(runtimeStops).toBe(1)
  })

  test("waits for idle cleanup before reacquiring the same session runtime", async () => {
    const cleanupStarted = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    let starts = 0
    const manager = createManager(
      {
        start: async () => {
          starts++
          const generation = starts
          return runtime(
            async () => {
              if (generation !== 1) return
              cleanupStarted.resolve()
              await releaseCleanup.promise
            },
            { generation: String(generation) },
          )
        },
      },
      1,
    )
    const input = { sessionID: "ses_reacquire", workarea: "/tmp/reacquire", objective: "Question" }

    await manager.acquire(input)
    manager.release(input.sessionID)
    await cleanupStarted.promise
    const reacquired = manager.acquire(input)
    await Promise.resolve()
    expect(starts).toBe(1)

    releaseCleanup.resolve()
    expect((await reacquired).env.generation).toBe("2")
    await manager.stopAll()
  })
})
