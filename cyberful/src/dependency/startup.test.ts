// ── External Dependency Lifecycle Tests ─────────────────────────
// Verifies that concurrent project bootstraps share one cyberful-os start, live
//   inventory reaches every subscriber, and repeated shutdown reaps once.
// → cyberful/src/dependency/startup.ts — owns the tested process registry.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { DependencyStartup, type CyberfulOsContainer, type ContainerRunner } from "./startup"

function container(name = "cyberful-os"): CyberfulOsContainer {
  return {
    command: ["cyberful-os-container"],
    cwd: "/tmp/cyberful-os",
    env: { CYBERFUL_OS_CONTAINER: name },
  }
}

function reset(runner: ContainerRunner) {
  DependencyStartup.resetForTests(runner)
}

afterEach(() => {
  DependencyStartup.resetForTests()
})

describe("cyberful-os dependency lifecycle", () => {
  test("concurrent project bootstraps share one container start", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const actions: string[] = []
    reset(async (_, action) => {
      actions.push(action)
      if (action === "up") {
        started.resolve()
        await release.promise
      }
      return 0
    })

    const first = DependencyStartup.startForTests(container())
    const second = DependencyStartup.startForTests(container())
    await started.promise

    expect(actions).toEqual(["up"])
    expect(DependencyStartup.liveCount()).toBe(1)

    release.resolve()
    await Promise.all([first, second])
    await DependencyStartup.stopStarted()

    expect(actions).toEqual(["up", "down"])
    expect(DependencyStartup.liveCount()).toBe(0)
  })

  test("independent listeners receive snapshots until they unsubscribe", async () => {
    reset(async () => 0)
    const first: string[][] = []
    const second: string[][] = []
    const unsubscribeFirst = DependencyStartup.onLiveChange((containers) => first.push(containers))
    const unsubscribeSecond = DependencyStartup.onLiveChange((containers) => second.push(containers))

    await DependencyStartup.startForTests(container("cyberful-os-shared"))
    expect(first.at(-1)).toEqual(["cyberful-os-shared"])
    expect(second.at(-1)).toEqual(["cyberful-os-shared"])

    unsubscribeFirst()
    await DependencyStartup.stopStarted()
    unsubscribeSecond()

    expect(first.at(-1)).toEqual(["cyberful-os-shared"])
    expect(second.at(-1)).toEqual([])
  })

  test("concurrent and repeated shutdown calls reap one owned container once", async () => {
    const downStarted = Promise.withResolvers<void>()
    const releaseDown = Promise.withResolvers<void>()
    let downs = 0
    reset(async (_, action) => {
      if (action === "down") {
        downs += 1
        downStarted.resolve()
        await releaseDown.promise
      }
      return 0
    })
    await DependencyStartup.startForTests(container())

    const first = DependencyStartup.stopStarted()
    const second = DependencyStartup.stopStarted()
    expect(second).toBe(first)
    await downStarted.promise
    expect(downs).toBe(1)

    releaseDown.resolve()
    await Promise.all([first, second])
    await DependencyStartup.stopStarted()

    expect(downs).toBe(1)
    expect(DependencyStartup.liveCount()).toBe(0)
  })

  test("failed startup cleanup stays tracked for a later shutdown retry", async () => {
    let downAttempts = 0
    reset(async (_, action) => {
      if (action === "up") return 1
      downAttempts += 1
      return downAttempts === 1 ? 1 : 0
    })

    await expect(DependencyStartup.startForTests(container())).rejects.toThrow(
      "startup failed and its container could not be cleaned up",
    )
    expect(DependencyStartup.liveCount()).toBe(1)

    await DependencyStartup.stopStarted()

    expect(downAttempts).toBe(2)
    expect(DependencyStartup.liveCount()).toBe(0)
  })
})
