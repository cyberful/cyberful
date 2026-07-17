// ── Prompt Queue Shutdown Contract Tests ─────────────────────────
// Protects the routine exit path while an interactive turn is still running,
// proving the queue waits for signal-driven cleanup before it reports closure.
// → cyberful/src/cli/cmd/run/runtime.queue.ts — owns the active turn and abort signal.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { observePromise } from "@/util/promise"
import { runPromptQueue } from "./runtime.queue"
import type { FooterApi } from "./types"

test("closing an active prompt waits for its aborted turn to release resources", async () => {
  const closeListeners = new Set<() => void>()
  const promptListeners = new Set<Parameters<FooterApi["onPrompt"]>[0]>()
  const footer: FooterApi = {
    isClosed: false,
    onPrompt(listener) {
      promptListeners.add(listener)
      return () => promptListeners.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    event() {},
    append() {},
    idle: () => Promise.resolve(),
    close() {
      for (const listener of closeListeners) listener()
    },
    destroy() {},
  }
  const turnStarted = Promise.withResolvers<AbortSignal>()
  const releaseCleanup = Promise.withResolvers<void>()
  let cleanupFinished = false
  const queue = runPromptQueue({
    footer,
    initialInput: "inspect the current session",
    run: async (_prompt, signal) => {
      turnStarted.resolve(signal)
      const aborted = Promise.withResolvers<unknown>()
      signal.addEventListener("abort", () => aborted.resolve(signal.reason), { once: true })
      const reason = await aborted.promise
      await releaseCleanup.promise
      cleanupFinished = true
      throw reason
    },
  })
  const signal = await turnStarted.promise
  let queueSettled = false
  observePromise(queue, {
    fulfilled: () => {
      queueSettled = true
    },
    rejected: (error) => {
      throw error
    },
  })

  footer.close()
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(signal.aborted).toBe(true)
  expect(queueSettled).toBe(false)
  expect(cleanupFinished).toBe(false)

  releaseCleanup.resolve()
  await queue
  expect(cleanupFinished).toBe(true)
})
