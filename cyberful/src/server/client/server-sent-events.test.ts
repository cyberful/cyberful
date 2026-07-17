// ── Event Stream Cancellation Contract Tests ────────────────────
// Protects the generated control-plane stream against cancellation failures
// that would otherwise escape as unobserved promises during routine shutdown.
// → cyberful/script/generate-client.ts — owns the persistent generator patch.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { createSseClient } from "./gen/core/serverSentEvents.gen"

test("aborting an event stream observes cancellation failure and stops retrying", async () => {
  const cancellationError = new Error("event stream cancellation failed")
  const fetchStarted = Promise.withResolvers<void>()
  let cancellationCount = 0
  const decodedBody = new ReadableStream<string>({
    cancel() {
      cancellationCount++
      return Promise.reject(cancellationError)
    },
  })
  // ── The Decoded Stream Exposes The Exact Failure Boundary ──────
  // The generated client always inserts TextDecoderStream before reading events.
  // Native transform cancellation does not reliably preserve a synthetic source
  // rejection across runtimes, so this response substitutes only pipeThrough's
  // decoded output. The real reader, abort listener, and cleanup path remain active.
  // ─────────────────────────────────────────────────────────────────
  const responseBody = new ReadableStream<Uint8Array>()
  Object.defineProperty(responseBody, "pipeThrough", { value: () => decodedBody })
  const response = new Response()
  Object.defineProperty(response, "body", { value: responseBody })
  const abort = new AbortController()
  const observedErrors: unknown[] = []
  const fetchResponse: typeof fetch = Object.assign(
    async () => {
      fetchStarted.resolve()
      return response
    },
    { preconnect: () => {} },
  )
  const result = createSseClient({
    url: "http://127.0.0.1/events",
    signal: abort.signal,
    fetch: fetchResponse,
    onSseError: (error) => observedErrors.push(error),
  })

  const pendingEvent = result.stream.next()
  await fetchStarted.promise
  abort.abort()

  expect(await pendingEvent).toEqual({ done: true, value: undefined })
  expect(cancellationCount).toBe(1)
  expect(observedErrors).toEqual([cancellationError])
})
