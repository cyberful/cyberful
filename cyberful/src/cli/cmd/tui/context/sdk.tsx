// ── Control-Plane Client Context ─────────────────────────────────
// Owns the scoped API client and global event subscription, reconnects the SSE
//   stream when necessary, and aborts network work when its provider unmounts.
// ─────────────────────────────────────────────────────────────────

import { createControlPlaneClient } from "@/server/client"
import type { GlobalEvent } from "@/server/client"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"

const log = Log.create({ service: "tui.sdk" })

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

function waitForRetry(ms: number, signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      for (const signal of signals) signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, ms)
    for (const signal of signals) signal.addEventListener("abort", done, { once: true })
    if (signals.some((signal) => signal.aborted)) done()
  })
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "Control plane",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()

    // ── Event Source Work Ends With Its Provider ─────────────────
    // Remote mode owns one retrying SSE task and cancels it with provider scope.
    // Worker mode receives an unsubscribe function asynchronously, so a late
    // subscription result checks the closed flag and releases itself immediately.
    // Every terminal failure is observed, while routine abort-driven settlement
    // remains quiet during renderer teardown.
    // ─────────────────────────────────────────────────────────────────
    let sse: AbortController | undefined
    let eventTask: Promise<void> | undefined
    let externalUnsubscribe: (() => void) | undefined
    let closed = false

    function createSDK() {
      return createControlPlaneClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      const task = (async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          try {
            const events = await sdk.global.event({
              signal: ctrl.signal,
              sseMaxRetryAttempts: 0,
            })

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              handleEvent(event)
            }
          } catch (error) {
            if (abort.signal.aborted || ctrl.signal.aborted) break
            log.warn("control-plane event stream disconnected", { error, attempt: attempt + 1 })
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await waitForRetry(backoff, [abort.signal, ctrl.signal])
        }
      })()
      eventTask = task
      observePromise(task, {
        rejected: (error) => log.error("control-plane event loop failed", { error }),
        settled: () => {
          if (eventTask === task) eventTask = undefined
        },
      })
    }

    onMount(() => {
      if (!props.events) {
        startSSE()
        return
      }
      observePromise(props.events.subscribe(handleEvent), {
        fulfilled: (unsubscribe) => {
          if (closed) {
            try {
              unsubscribe()
            } catch (error) {
              log.error("failed to release late worker event subscription", { error })
            }
            return
          }
          externalUnsubscribe = unsubscribe
        },
        rejected: (error) => log.error("failed to subscribe to worker events", { error }),
      })
    })

    onCleanup(() => {
      closed = true
      abort.abort()
      sse?.abort()
      try {
        externalUnsubscribe?.()
      } catch (error) {
        log.error("failed to unsubscribe from worker events", { error })
      }
      externalUnsubscribe = undefined
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
