// ── Docker Availability Contract Tests ───────────────────────────
// Verifies that startup accepts a reachable daemon and gives users an
// actionable failure before an engagement starts without required containers.
// → cyberful/src/dependency/docker-preflight.ts — owns the preflight contract.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { DockerPreflight } from "./docker-preflight"

describe("Docker preflight", () => {
  test("accepts only a reachable Docker server", async () => {
    const commands: string[][] = []
    await DockerPreflight.requireDockerDaemon(async (command) => {
      commands.push(command)
      return 0
    })
    expect(commands).toEqual([["docker", "version", "--format", "{{.Server.Version}}"]])
  })

  test("fails with an actionable blocking error when the daemon is unreachable", async () => {
    await expect(DockerPreflight.requireDockerDaemon(async () => 1)).rejects.toThrow(
      "Start Docker Desktop (or the configured Docker daemon) and relaunch Cyberful",
    )
  })
})
