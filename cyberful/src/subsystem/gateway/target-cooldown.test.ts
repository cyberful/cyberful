// ── Authorized Target Transport Cooldown Tests ─────────────────
// Verifies narrow eligibility, bounded duration, one-use accounting, shared
//   cooperative blocking, cancellation, and engagement authority.
// → cyberful/src/subsystem/gateway/target-cooldown.ts — owns the behavior under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { EngagementPolicy } from "./engagement-policy"
import {
  TARGET_COOLDOWN_DEFAULT_SECONDS,
  TARGET_COOLDOWN_MAX_SECONDS,
  TargetCooldownController,
} from "./target-cooldown"

const policy: EngagementPolicy = {
  version: 1,
  stage: "final",
  updated_at: "2026-08-06T00:00:00.000Z",
  profiles: [],
  authorized_http_hosts: ["app.example.test", "*.api.example.test"],
  global_http_rps: null,
  required_http_headers: [],
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    origin: "https://app.example.test",
    previously_responsive: true,
    consecutive_transport_failures: 2,
    transport_error: "empty_response",
    evidence_summary: "Two empty responses followed an observed HTTP 200.",
    ...overrides,
  }
}

describe("TargetCooldownController", () => {
  test("defaults to three minutes and permits caller expansion only up to six", async () => {
    const delays: number[] = []
    const controller = new TargetCooldownController({
      sleep: async (delayMs) => {
        delays.push(delayMs)
      },
      now: () => 0,
    })

    const first = await controller.run(request(), policy, new AbortController().signal)
    const second = await controller.run(
      request({ origin: "https://one.api.example.test", duration_seconds: TARGET_COOLDOWN_MAX_SECONDS }),
      policy,
      new AbortController().signal,
    )

    expect(first.duration_seconds).toBe(TARGET_COOLDOWN_DEFAULT_SECONDS)
    expect(second.duration_seconds).toBe(TARGET_COOLDOWN_MAX_SECONDS)
    expect(delays).toEqual([180_000, 360_000])
    await expect(
      controller.run(
        request({ origin: "https://two.api.example.test", duration_seconds: 361 }),
        policy,
        new AbortController().signal,
      ),
    ).rejects.toThrow("between 180 and 360")
  })

  test("blocks later work without cancelling it and rejects a second cooldown for the origin", async () => {
    let finishSleep = () => {}
    const controller = new TargetCooldownController({
      sleep: () =>
        new Promise<void>((resolve) => {
          finishSleep = resolve
        }),
    })
    const cooldown = controller.run(request(), policy, new AbortController().signal)
    let passed = false
    const waiter = controller.wait(new AbortController().signal).then(() => {
      passed = true
    })

    await Promise.resolve()
    expect(passed).toBe(false)
    await expect(controller.run(request(), policy, new AbortController().signal)).rejects.toThrow(
      "already active",
    )
    finishSleep()
    await Promise.all([cooldown, waiter])
    expect(passed).toBe(true)
    await expect(controller.run(request(), policy, new AbortController().signal)).rejects.toThrow(
      "already used",
    )
  })

  test("rejects ineligible evidence and origins outside the engagement policy", async () => {
    const controller = new TargetCooldownController({ sleep: async () => {} })
    const signal = new AbortController().signal

    await expect(controller.run(request({ origin: "https://outside.test" }), policy, signal)).rejects.toThrow(
      "not authorized",
    )
    await expect(
      controller.run(request({ transport_error: "http_429", origin: "https://one.api.example.test" }), policy, signal),
    ).rejects.toThrow("empty_response")
    await expect(
      controller.run(request({ previously_responsive: false, origin: "https://two.api.example.test" }), policy, signal),
    ).rejects.toThrow("previously_responsive")
  })

  test("gateway close releases cooperative waiters and aborts the active timer", async () => {
    const controller = new TargetCooldownController({
      sleep: (_delayMs, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    })
    const cooldown = controller.run(request(), policy, new AbortController().signal)
    const waiter = controller.wait(new AbortController().signal)

    controller.close()

    await expect(cooldown).rejects.toThrow("closed during target cooldown")
    await expect(waiter).resolves.toBeUndefined()
  })
})
