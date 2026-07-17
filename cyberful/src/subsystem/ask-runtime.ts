// ── Interactive Ask Runtime Manager ─────────────────────────────
// Reuses one engagement ZAP and cyberful-os runtime across Ask turns, tracks active
// borrowers, and performs idempotent cleanup after bounded inactivity or shutdown.
// → cyberful/src/subsystem/zap/runtime.ts — owns engagement-scoped ZAP resources.
// ─────────────────────────────────────────────────────────────────

import type { EngagementRuntime } from "./zap/runtime"
import { SubsystemZapRuntime } from "./zap/runtime"
import { SubsystemContainer } from "./container"
import { SubsystemPhase } from "./phase"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"

const log = Log.create({ service: "ask-runtime" })

export const IDLE_TIMEOUT_MS = 15 * 60_000

interface Entry {
  runtime: EngagementRuntime
  container: string
  timer?: ReturnType<typeof setTimeout>
}

interface Dependencies {
  start: typeof SubsystemZapRuntime.startEngagement
  remember: typeof SubsystemContainer.remember
  reap: typeof SubsystemContainer.reap
  remove: typeof SubsystemContainer.remove
}

export function createManager(deps: Dependencies, idleTimeoutMs = IDLE_TIMEOUT_MS) {
  const entries = new Map<string, Entry>()
  const starting = new Map<string, Promise<Entry>>()
  const stopping = new Map<string, Promise<void>>()

  async function completeCleanup(tasks: Promise<unknown>[], message: string) {
    const results = await Promise.allSettled(tasks)
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, message)
  }

  async function stopEntry(sessionID: string, entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entries.delete(sessionID)
    await completeCleanup([entry.runtime.stop(), deps.remove(entry.container)], "Ask runtime cleanup failed")
  }

  // ── Cleanup Has One Manager-Owned Task Per Session ────────────
  // Idle timers must start asynchronous cleanup from a synchronous callback,
  // while explicit shutdown must be able to join that same work. The stopping
  // map owns each in-flight task before it can settle, observes every failure,
  // and removes only the matching task after settlement. Explicit stop, stopAll,
  // and reacquisition therefore join cleanup instead of racing or duplicating it.
  // ─────────────────────────────────────────────────────────────────
  function startOwnedStop(sessionID: string, entry: Entry, options: { reportFailure: boolean }): void {
    if (stopping.has(sessionID)) return
    const task = stopEntry(sessionID, entry)
    stopping.set(sessionID, task)
    observePromise(task, {
      rejected: (error) => {
        if (options.reportFailure) log.warn("Ask runtime cleanup failed", { sessionID, error })
      },
      settled: () => {
        if (stopping.get(sessionID) === task) stopping.delete(sessionID)
      },
    })
  }

  async function acquire(input: { sessionID: string; workarea: string; objective: string; signal?: AbortSignal }) {
    const existing = entries.get(input.sessionID)
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      existing.timer = undefined
      return existing.runtime
    }
    const activeStop = stopping.get(input.sessionID)
    if (activeStop) await activeStop
    const pending = starting.get(input.sessionID)
    if (pending) return (await pending).runtime

    const promise = (async () => {
      const container = SubsystemPhase.expertContainerName(input.workarea, input.sessionID)
      deps.remember(container)
      try {
        await deps.reap(container)
        const entry = {
          runtime: await deps.start(input),
          container,
        } satisfies Entry
        entries.set(input.sessionID, entry)
        return entry
      } catch (error) {
        try {
          await deps.remove(container)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Ask runtime startup and cleanup failed")
        }
        throw error
      }
    })()
    starting.set(input.sessionID, promise)
    try {
      return (await promise).runtime
    } finally {
      starting.delete(input.sessionID)
    }
  }

  function release(sessionID: string) {
    const entry = entries.get(sessionID)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      startOwnedStop(sessionID, entry, { reportFailure: true })
    }, idleTimeoutMs)
    entry.timer.unref?.()
  }

  async function stop(sessionID: string) {
    const activeStop = stopping.get(sessionID)
    if (activeStop) return activeStop
    const pending = starting.get(sessionID)
    const entry = entries.get(sessionID) ?? (pending ? await pending : undefined)
    if (!entry) return
    startOwnedStop(sessionID, entry, { reportFailure: false })
    await stopping.get(sessionID)
  }

  async function stopAll() {
    await completeCleanup(
      [...new Set([...entries.keys(), ...starting.keys(), ...stopping.keys()])].map(stop),
      "Ask runtime shutdown failed",
    )
  }

  return { acquire, release, stop, stopAll }
}

const manager = createManager({
  start: SubsystemZapRuntime.startEngagement,
  remember: SubsystemContainer.remember,
  reap: SubsystemContainer.reap,
  remove: SubsystemContainer.remove,
})

export const acquire = manager.acquire
export const release = manager.release
export const stop = manager.stop
export const stopAll = manager.stopAll

export * as SubsystemAskRuntime from "./ask-runtime"
