// ── cyberful-os Container Cleanup Tests ────────────────────────────
// Verifies that routine shutdown reaps every remembered engagement container,
// clears ownership state, and handles repeated registration without duplicate work.
// → cyberful/src/subsystem/container.ts — owns the tested cleanup registry.
// ─────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, test } from "bun:test"
import { SubsystemContainer } from "./container"

// ── Shutdown Owns Containers Left By Interrupted Sessions ───────
// cyberful-os containers deliberately outlive their launching command and cannot
// rely on Docker's automatic removal. Normal completion removes them directly;
// interruption leaves their deterministic names with the process shutdown owner.
// These tests exercise that production registry without requiring a Docker daemon.
// ─────────────────────────────────────────────────────────────────
describe("SubsystemContainer reaping", () => {
  let reaped: string[]
  beforeEach(() => {
    reaped = []
    SubsystemContainer.setReaperForTests(async (name) => {
      reaped.push(name)
    })
    SubsystemContainer.setOwnedContainerListerForTests(async () => [])
  })

  test("removeAll reaps every remembered container and clears the registry", async () => {
    SubsystemContainer.remember("cyberful-os-expert-alpha")
    SubsystemContainer.remember("cyberful-os-expert-beta")
    expect(SubsystemContainer.liveCount()).toBe(2)

    await SubsystemContainer.removeAll()

    expect(reaped.sort()).toEqual(["cyberful-os-expert-alpha", "cyberful-os-expert-beta"])
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("remember is idempotent — an engagement's repeated phases register one name", () => {
    SubsystemContainer.remember("cyberful-os-expert-alpha")
    SubsystemContainer.remember("cyberful-os-expert-alpha")
    expect(SubsystemContainer.liveCount()).toBe(1)
  })

  test("remove reaps one container and drops it, so removeAll then skips it", async () => {
    SubsystemContainer.remember("cyberful-os-expert-alpha")
    SubsystemContainer.remember("cyberful-os-expert-beta")

    await SubsystemContainer.remove("cyberful-os-expert-alpha")
    expect(reaped).toEqual(["cyberful-os-expert-alpha"])
    expect(SubsystemContainer.liveCount()).toBe(1)

    await SubsystemContainer.removeAll()
    expect(reaped).toEqual(["cyberful-os-expert-alpha", "cyberful-os-expert-beta"])
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("reap (the force-fresh path) removes a container WITHOUT unregistering it", async () => {
    SubsystemContainer.remember("cyberful-os-expert-alpha")

    await SubsystemContainer.reap("cyberful-os-expert-alpha")
    expect(reaped).toEqual(["cyberful-os-expert-alpha"])
    expect(SubsystemContainer.liveCount()).toBe(1)

    await SubsystemContainer.removeAll()
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("a pending clean removal stays registered for the shutdown backstop", async () => {
    const release = Promise.withResolvers<void>()
    const removalStarted = Promise.withResolvers<void>()
    SubsystemContainer.setReaperForTests(async () => {
      removalStarted.resolve()
      await release.promise
    })
    SubsystemContainer.remember("cyberful-os-expert-alpha")

    const removing = SubsystemContainer.remove("cyberful-os-expert-alpha")
    await removalStarted.promise
    expect(SubsystemContainer.liveCount()).toBe(1)

    release.resolve()
    await removing
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("a failed removal stays registered for the main-process fallback", async () => {
    SubsystemContainer.setReaperForTests(async () => {
      throw new Error("docker unavailable")
    })
    SubsystemContainer.remember("cyberful-os-expert-alpha")

    let failure: unknown
    try {
      await SubsystemContainer.removeAll()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected aggregated container cleanup failure")
    expect(failure.message).toBe("one or more Cyberful containers could not be removed")
    expect(failure.errors).toHaveLength(1)
    expect(failure.errors[0]).toMatchObject({ message: "docker unavailable" })
    expect(SubsystemContainer.liveCount()).toBe(1)
  })

  test("bounded cleanup attempts every container and retains only failures", async () => {
    let active = 0
    let maximumActive = 0
    const attempted: string[] = []
    const failed = new Set(["container-3", "container-17"])
    SubsystemContainer.setReaperForTests(async (name) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      attempted.push(name)
      try {
        await Promise.resolve()
        if (failed.has(name)) throw new Error(`cannot remove ${name}`)
      } finally {
        active -= 1
      }
    })
    for (let index = 0; index < 20; index += 1) SubsystemContainer.remember(`container-${index}`)

    let failure: unknown
    try {
      await SubsystemContainer.removeAll()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect(attempted.toSorted()).toEqual(Array.from({ length: 20 }, (_, index) => `container-${index}`).toSorted())
    expect(maximumActive).toBeLessThanOrEqual(8)
    expect(SubsystemContainer.liveCount()).toBe(2)
  })

  test("removeAll is a no-op when nothing is registered", async () => {
    await SubsystemContainer.removeAll()
    expect(reaped).toEqual([])
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("publishes the live Docker inventory for the main-process fallback", async () => {
    const snapshots: string[][] = []
    const unsubscribe = SubsystemContainer.onLiveChange((containers) => snapshots.push(containers))

    try {
      SubsystemContainer.remember("cyberful-os-expert-alpha")
      await SubsystemContainer.removeAll()

      expect(snapshots).toContainEqual(["cyberful-os-expert-alpha"])
      expect(snapshots.at(-1)).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  test("shutdown discovers a container recreated after the registry pass", async () => {
    const name = "cyberful-os-expert-alpha"
    SubsystemContainer.remember(name)
    SubsystemContainer.setOwnedContainerListerForTests(async (runID) => {
      expect(runID).toBe("run-alpha")
      return [name]
    })

    await SubsystemContainer.removeForShutdown("run-alpha")

    expect(reaped).toEqual([name, name])
    expect(SubsystemContainer.liveCount()).toBe(0)
  })

  test("derives scoped Docker filters from a non-reversible run token", () => {
    const filters = SubsystemContainer.ownerFilterArguments("run-alpha")

    expect(filters).toEqual([
      "--filter",
      `label=${SubsystemContainer.OWNER_LABEL}=${SubsystemContainer.ownerToken("run-alpha")}`,
      "--filter",
      `label=${SubsystemContainer.RUNTIME_LABEL}=${SubsystemContainer.EXPERT_RUNTIME}`,
    ])
    expect(filters.join(" ")).not.toContain("run-alpha")
  })
})
