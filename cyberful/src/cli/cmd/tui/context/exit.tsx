// ── Idempotent TUI Exit Context ──────────────────────────────────
// Owns one terminal shutdown promise, optional final message, renderer teardown,
//   and before/after callbacks so concurrent exit paths cannot race cleanup.
// ─────────────────────────────────────────────────────────────────

import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { win32FlushInputBuffer } from "../win32"
import { observePromise } from "@/util/promise"
import { onCleanup } from "solid-js"
import * as Log from "@/util/log"

const log = Log.create({ service: "tui.exit" })
type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
  finalizer: {
    add: (finalizer: () => Promise<void>) => () => void
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onBeforeExit?: () => Promise<void>; onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    const finalizers = new Set<() => Promise<void>>()
    let message: string | undefined
    let task: Promise<void> | undefined
    const store = {
      set: (value?: string) => {
        const prev = message
        message = value
        return () => {
          message = prev
        }
      },
      clear: () => {
        message = undefined
      },
      get: () => message,
    }
    const exit: Exit = Object.assign(
      (reason?: unknown) => {
        if (task) return task
        task = (async () => {
          await input.onBeforeExit?.()

          // ── Persistence Drains Before Renderer Ownership Ends ───
          // Prompt state providers own serialized file queues below this context.
          // Renderer destruction unmounts those providers, so their pending work
          // must settle first. Every registered drain runs even when a sibling
          // fails; failures are logged while terminal restoration still proceeds.
          // This ordering preserves recent user input without making exit fragile.
          // ─────────────────────────────────────────────────────────────────
          const settled = await Promise.allSettled([...finalizers].map((finalizer) => finalizer()))
          for (const result of settled) {
            if (result.status === "rejected") log.warn("TUI exit finalizer failed", { error: result.reason })
          }

          // Reset window title before destroying renderer
          renderer.setTerminalTitle("")
          renderer.destroy()
          win32FlushInputBuffer()
          if (reason) {
            const formatted = FormatError(reason) ?? FormatUnknownError(reason)
            if (formatted) {
              process.stderr.write(formatted + "\n")
            }
          }
          const text = store.get()
          if (text) process.stdout.write(text + "\n")
          await input.onExit?.()
        })()
        return task
      },
      {
        message: store,
        finalizer: {
          add(finalizer: () => Promise<void>) {
            finalizers.add(finalizer)
            return () => finalizers.delete(finalizer)
          },
        },
      },
    )
    const handleSighup = () => {
      observePromise(exit(), {
        rejected: (error) => log.error("TUI signal shutdown failed", { error }),
      })
    }
    process.on("SIGHUP", handleSighup)
    onCleanup(() => process.off("SIGHUP", handleSighup))
    return exit
  },
})
