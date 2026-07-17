// ── Ask Runtime Lifecycle Tests ──────────────────────────────────
// Verifies routine reuse, idle expiry, reacquisition, and terminal cleanup of
// the shared operational runtime used by interactive Ask sessions.
// → cyberful/src/subsystem/ask-runtime.ts — owns the tested runtime manager.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { EngagementRuntime } from "./zap/runtime"
import { createManager } from "./ask-runtime"
import { SubsystemPhase } from "./phase"

describe("Ask operational runtime lifecycle", () => {
  test("reuses one runtime, stops it after inactivity, and restarts transparently", async () => {
    let starts = 0
    let stops = 0
    const removed: string[] = []
    const idleCleanupObserved = Promise.withResolvers<void>()
    const manager = createManager(
      {
        start: async () => {
          starts++
          return {
            env: {},
            degraded: false,
            stop: async () => {
              stops++
            },
          } satisfies EngagementRuntime
        },
        remember: () => {},
        reap: async () => {},
        remove: async (container) => {
          removed.push(container)
          idleCleanupObserved.resolve()
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
    expect(removed).toEqual([SubsystemPhase.expertContainerName(input.workarea, input.sessionID)])

    await manager.acquire(input)
    expect(starts).toBe(2)
    await manager.stopAll()
    expect(stops).toBe(2)
  })

  test("cleans up the owned container when startup fails", async () => {
    const removed: string[] = []
    const manager = createManager({
      start: async () => {
        throw new Error("runtime failed")
      },
      remember: () => {},
      reap: async () => {},
      remove: async (container) => {
        removed.push(container)
      },
    })

    await expect(
      manager.acquire({ sessionID: "ses_failed", workarea: "/tmp/failure", objective: "Question" }),
    ).rejects.toThrow("runtime failed")
    expect(removed).toEqual([SubsystemPhase.expertContainerName("/tmp/failure", "ses_failed")])
  })

  test("runs every shutdown action and reports cleanup failures", async () => {
    let runtimeStops = 0
    let containerRemovals = 0
    const manager = createManager({
      start: async () => ({
        env: {},
        degraded: false,
        stop: async () => {
          runtimeStops++
          throw new Error("ZAP cleanup failed")
        },
      }),
      remember: () => {},
      reap: async () => {},
      remove: async () => {
        containerRemovals++
        throw new Error("container cleanup failed")
      },
    })

    await manager.acquire({ sessionID: "ses_cleanup", workarea: "/tmp/cleanup", objective: "Question" })
    await expect(manager.stopAll()).rejects.toThrow("Ask runtime shutdown failed")
    expect(runtimeStops).toBe(1)
    expect(containerRemovals).toBe(1)
  })

  test("joins cleanup already started by idle expiry during shutdown", async () => {
    const cleanupStarted = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    let runtimeStops = 0
    let containerRemovals = 0
    const manager = createManager(
      {
        start: async () => ({
          env: {},
          degraded: false,
          stop: async () => {
            runtimeStops++
            cleanupStarted.resolve()
            await releaseCleanup.promise
          },
        }),
        remember: () => {},
        reap: async () => {},
        remove: async () => {
          containerRemovals++
        },
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
    expect(containerRemovals).toBe(1)
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
          return {
            env: { generation: String(generation) },
            degraded: false,
            stop: async () => {
              if (generation !== 1) return
              cleanupStarted.resolve()
              await releaseCleanup.promise
            },
          }
        },
        remember: () => {},
        reap: async () => {},
        remove: async () => {},
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
