// ── Shared Browser Hub Lifecycle Contract ───────────────────────────
// Proves hub/controller single-flight, cross-owner isolation, owner cleanup,
// profile-wide root closure, interruption, and lazy recreation without Chromium.
// → cyberful/src/subsystem/gateway/browser-profile-hub.ts — implements the lifecycle boundary.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { BrowserProfileHub } from "./browser-profile-hub"

interface FakeController {
  readonly runID: string
  closed: boolean
}

function harness() {
  let hubs = 0
  const controllers: FakeController[] = []
  const runtime = new BrowserProfileHub<FakeController>({
    label: "browser-1",
    cancellationGraceMs: 0,
    connectHub: async () => {
      const id = ++hubs
      return {
        endpoint: `http://127.0.0.1:${id}`,
        attestation: "{}",
        alive: async () => true,
        close: async () => undefined,
      }
    },
    connectController: async (_hub, onClose) => {
      const controller = { runID: `controller-${controllers.length + 1}`, closed: false }
      controllers.push(controller)
      return {
        value: controller,
        close: async () => {
          controller.closed = true
          onClose()
        },
      }
    },
    probeController: async (controller) => {
      if (controller.closed) throw new Error("closed")
    },
    probeTimeoutMs: 100,
  })
  return { runtime, controllers, hubs: () => hubs }
}

describe("shared browser profile hub", () => {
  test("shares one hub while isolating controllers per AgentRun", async () => {
    const { runtime, controllers, hubs } = harness()
    const [first, second] = await Promise.all([
      runtime.call("run-a", async (controller) => controller.runID),
      runtime.call("run-b", async (controller) => controller.runID),
    ])

    expect(hubs()).toBe(1)
    expect(first).not.toBe(second)
    expect(controllers).toHaveLength(2)
    await runtime.close()
  })

  test("owner cleanup preserves sibling controllers", async () => {
    const { runtime, controllers } = harness()
    await runtime.call("run-a", async () => undefined)
    await runtime.call("run-b", async () => undefined)
    await runtime.releaseOwner("run-a")

    expect(controllers[0]?.closed).toBe(true)
    expect(controllers[1]?.closed).toBe(false)
    await runtime.call("run-b", async (controller) => expect(controller.closed).toBe(false))
    await runtime.close()
  })

  test("profile close interrupts all controllers and later use recreates the hub", async () => {
    const { runtime, controllers, hubs } = harness()
    await runtime.call("run-a", async () => undefined)
    await runtime.call("run-b", async () => undefined)
    await runtime.closeProfile()

    expect(controllers.every((controller) => controller.closed)).toBe(true)
    await runtime.call("run-a", async (controller) => expect(controller.closed).toBe(false))
    expect(hubs()).toBe(2)
    await runtime.close()
  })
})
