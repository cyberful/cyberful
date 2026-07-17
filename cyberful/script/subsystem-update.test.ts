// ── Subsystem Version Transaction Tests ─────────────────────────
// Proves that compatible candidates reach functional pins without reading or
// mutating documentation, while rejected candidates restore the prior install.
// → cyberful/script/subsystem-update.ts — implements the tested transaction.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { updateSubsystem } from "./subsystem-update"
import type { CommandResult, CommandRunner, ManagedSubsystem } from "./subsystem-update"

const completed = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" })

function fixtureSubsystem(root: string): ManagedSubsystem {
  const command = (name: string) => ({
    argv: [name] as [string],
    cwd: root,
    output: "capture" as const,
    timeoutMs: 1_000,
  })
  return {
    name: "fixture",
    pinnedVersion: "1.0.0",
    availableVersionCommand: command("available"),
    installedVersionCommand: command("installed"),
    parseAvailableVersion: (result) => result.stdout.trim(),
    parseInstalledVersion: (result) => (result.exitCode === 0 ? result.stdout.trim() : null),
    installCommand: (version) => ({ ...command("install"), argv: ["install", version], output: "inherit" }),
    compatibilityCommand: () => ({ ...command("compatibility"), output: "inherit" }),
    functionalPinFiles: ["runtime.txt", "ci.yml"],
  }
}

function fixtureRunner(compatibilityExitCode: number) {
  let installedVersion = "1.0.0"
  const installedVersions: string[] = []
  const run: CommandRunner = async (command) => {
    const operation = command.argv[0]
    if (operation === "available") return completed("2.0.0\n")
    if (operation === "installed") return completed(`${installedVersion}\n`)
    if (operation === "install") {
      installedVersion = command.argv[1] ?? ""
      installedVersions.push(installedVersion)
      return completed()
    }
    if (operation === "compatibility") return { exitCode: compatibilityExitCode, stdout: "", stderr: "rejected" }
    return { exitCode: 1, stdout: "", stderr: `unexpected command ${operation}` }
  }
  return { run, installedVersions, installedVersion: () => installedVersion }
}

describe("subsystem version maintenance", () => {
  test("persists every declared pin only after the candidate contract passes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-subsystem-update-"))
    try {
      await Promise.all([
        Bun.write(path.join(root, "runtime.txt"), "version=1.0.0\n"),
        Bun.write(path.join(root, "ci.yml"), "SUBSYSTEM_VERSION: 1.0.0\n"),
        Bun.write(path.join(root, "README.md"), "Use 1.0.0.\n"),
      ])
      const fixture = fixtureRunner(0)

      await updateSubsystem(fixtureSubsystem(root), { repositoryRoot: root, runCommand: fixture.run, log: () => {} })

      expect(await Bun.file(path.join(root, "runtime.txt")).text()).toBe("version=2.0.0\n")
      expect(await Bun.file(path.join(root, "ci.yml")).text()).toBe("SUBSYSTEM_VERSION: 2.0.0\n")
      expect(await Bun.file(path.join(root, "README.md")).text()).toBe("Use 1.0.0.\n")
      expect(fixture.installedVersions).toEqual(["2.0.0"])
      expect(fixture.installedVersion()).toBe("2.0.0")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps pins unchanged and restores the installation when compatibility fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-subsystem-rollback-"))
    try {
      await Promise.all([
        Bun.write(path.join(root, "runtime.txt"), "version=1.0.0\n"),
        Bun.write(path.join(root, "ci.yml"), "SUBSYSTEM_VERSION: 1.0.0\n"),
      ])
      const fixture = fixtureRunner(1)

      await expect(
        updateSubsystem(fixtureSubsystem(root), {
          repositoryRoot: root,
          runCommand: fixture.run,
          log: () => {},
        }),
      ).rejects.toThrow("previous installation was restored")

      expect(await Bun.file(path.join(root, "runtime.txt")).text()).toBe("version=1.0.0\n")
      expect(await Bun.file(path.join(root, "ci.yml")).text()).toBe("SUBSYSTEM_VERSION: 1.0.0\n")
      expect(fixture.installedVersions).toEqual(["2.0.0", "1.0.0"])
      expect(fixture.installedVersion()).toBe("1.0.0")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects adapters that declare documentation as a functional pin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-subsystem-doc-pin-"))
    try {
      await Bun.write(path.join(root, "README.md"), "Use 1.0.0.\n")
      const fixture = fixtureRunner(0)
      const subsystem = { ...fixtureSubsystem(root), functionalPinFiles: ["README.md"] }

      await expect(
        updateSubsystem(subsystem, { repositoryRoot: root, runCommand: fixture.run, log: () => {} }),
      ).rejects.toThrow("functional pins must not include documentation")

      expect(await Bun.file(path.join(root, "README.md")).text()).toBe("Use 1.0.0.\n")
      expect(fixture.installedVersions).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
