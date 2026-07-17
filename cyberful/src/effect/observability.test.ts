// ── Local Observability Network Boundary ───────────────────────────
// Verifies application runtime startup remains local even when legacy OTLP
// environment variables are present and never invokes the host fetch transport.
// → cyberful/src/effect/observability.ts — defines the local-only runtime layer.
// ────────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { Observability } from "./observability"

test("application runtime startup never exports telemetry", async () => {
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
  const blockedFetch = Object.assign(
    async () => {
      throw new Error("observability attempted an outbound request")
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const fetch = spyOn(globalThis, "fetch").mockImplementation(blockedFetch)
  const runtime = ManagedRuntime.make(Observability.layer)

  try {
    await runtime.runPromise(Effect.void)
    expect(Observability.enabled).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
    fetch.mockRestore()
    if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint
  }
})
