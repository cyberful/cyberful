#!/usr/bin/env bun
// ── Registered Subsystem Maintenance ─────────────────────────────
// Registers release-channel, installation, compatibility, and pin ownership
// for host subsystems maintained through the root `make subsystems` command.
// → cyberful/script/subsystem-update.ts — owns the generic update transaction.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { CODEX_PINNED_VERSION } from "../src/dependency/codex"
import { updateSubsystem } from "./subsystem-update"
import type { CommandResult, ManagedSubsystem } from "./subsystem-update"

const repositoryRoot = path.resolve(import.meta.dir, "../..")
const packageRoot = path.resolve(import.meta.dir, "..")
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const CODEX_VERSION_PATTERN = /^\s*codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/

function validatedVersion(value: unknown, source: string) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${source} did not return one semantic version`)
  }
  return value
}

function npmVersion(result: CommandResult) {
  let decoded: unknown
  try {
    decoded = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error("npm returned malformed JSON while discovering Codex", { cause: error })
  }
  return validatedVersion(decoded, "npm")
}

function installedCodexVersion(result: CommandResult) {
  if (result.exitCode !== 0) return null
  const version = CODEX_VERSION_PATTERN.exec(result.stdout)?.[1]
  return validatedVersion(version, "codex --version")
}

// ── Adapters Own Product-Specific Policy ────────────────────────
// The coordinator knows only version discovery, executable installation,
// compatibility, rollback, and declared pin files. Each registry entry selects
// its authoritative release channel and exact commands without introducing
// shell evaluation. Adding a future subsystem is therefore an adapter and pin
// inventory change; transaction and failure semantics remain shared. Only
// runtime and CI artifacts belong to that inventory; documentation stays
// outside discovery, validation, mutation, and rollback.
// ─────────────────────────────────────────────────────────────────
const codex = {
  name: "codex",
  pinnedVersion: CODEX_PINNED_VERSION,
  availableVersionCommand: {
    argv: ["npm", "view", "@openai/codex", "version", "--json"],
    cwd: repositoryRoot,
    output: "capture",
    timeoutMs: 60_000,
  },
  installedVersionCommand: {
    argv: ["codex", "--version"],
    cwd: repositoryRoot,
    output: "capture",
    timeoutMs: 10_000,
  },
  parseAvailableVersion: npmVersion,
  parseInstalledVersion: installedCodexVersion,
  installCommand: (version) => ({
    argv: ["npm", "install", "--global", `@openai/codex@${version}`],
    cwd: repositoryRoot,
    output: "inherit",
    timeoutMs: 300_000,
  }),
  compatibilityCommand: () => ({
    argv: [
      "bun",
      "test",
      "--isolate",
      "--no-orphans",
      "--timeout",
      "60000",
      "src/subsystem/codex-compat.integration.test.ts",
    ],
    cwd: packageRoot,
    output: "inherit",
    timeoutMs: 120_000,
  }),
  functionalPinFiles: [".github/workflows/_verify.yml.disabled", "cyberful/src/dependency/codex.ts"],
} satisfies ManagedSubsystem

const registeredSubsystems = [codex] satisfies readonly ManagedSubsystem[]

function selectedSubsystems(arguments_: readonly string[]) {
  const requested = new Set(arguments_)
  if (requested.size !== arguments_.length) throw new Error("Subsystem names must not be repeated")
  const known = new Set(registeredSubsystems.map((subsystem) => subsystem.name))
  const unknown = arguments_.filter((name) => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(`Unknown subsystem: ${unknown.join(", ")}; available: ${[...known].join(", ")}`)
  }
  return arguments_.length === 0
    ? registeredSubsystems
    : registeredSubsystems.filter((subsystem) => requested.has(subsystem.name))
}

async function main() {
  const subsystems = selectedSubsystems(process.argv.slice(2))
  for (const subsystem of subsystems) await updateSubsystem(subsystem, { repositoryRoot })
  console.log(`\n✓ ${subsystems.length} subsystem${subsystems.length === 1 ? "" : "s"} maintained successfully`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`\n✗ Subsystem maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
