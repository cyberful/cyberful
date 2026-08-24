#!/usr/bin/env bun
// ── Curated Dependency Maintenance ───────────────────────────────
// Inventories available releases, audits every JavaScript dependency graph,
// and verifies reviewed updates without changing declared dependency versions.
// → AGENTS.md — defines the review and grouping rules around these commands.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "..")
const mcpRoot = path.join(repositoryRoot, "mcps")
const zapRoot = path.join(mcpRoot, "zap")

const modes = ["inventory", "audit", "verify", "all"] as const
type Mode = (typeof modes)[number]

type MaintenanceCommand = {
  readonly label: string
  readonly command: readonly string[]
  readonly cwd: string
}

const commands = {
  inventory: [
    {
      label: "Bun workspace updates",
      command: ["bun", "outdated", "--recursive"],
      cwd: repositoryRoot,
    },
    {
      label: "cyberful-os npm updates",
      command: ["npm", "outdated", "--all"],
      cwd: mcpRoot,
    },
    {
      label: "ZAP bridge Bun updates",
      command: ["bun", "outdated"],
      cwd: zapRoot,
    },
  ],
  audit: [
    {
      label: "Bun workspace advisories",
      command: ["bun", "audit"],
      cwd: repositoryRoot,
    },
    {
      label: "cyberful-os npm advisories",
      command: ["npm", "audit"],
      cwd: mcpRoot,
    },
    {
      label: "ZAP bridge Bun advisories",
      command: ["bun", "audit"],
      cwd: zapRoot,
    },
  ],
  verify: [
    {
      label: "Frozen Bun workspace install",
      command: ["bun", "install", "--frozen-lockfile"],
      cwd: repositoryRoot,
    },
    {
      label: "Frozen cyberful-os npm install",
      command: ["npm", "ci"],
      cwd: mcpRoot,
    },
    {
      label: "Frozen ZAP bridge Bun install",
      command: ["bun", "install", "--frozen-lockfile"],
      cwd: zapRoot,
    },
    {
      label: "Dependency change checks",
      command: ["make", "typecheck", "test-bun", "test-python"],
      cwd: repositoryRoot,
    },
  ],
} satisfies Record<Exclude<Mode, "all">, readonly MaintenanceCommand[]>

function printUsage() {
  console.log(`Usage: bun scripts/dependencies.ts <mode>

Modes:
  inventory  List available releases without changing manifests or lockfiles.
  audit      Check the root, cyberful-os, and ZAP bridge dependency graphs.
  verify     Verify frozen installs, typechecking, and local unit tests.
  all        Run inventory, audit, and verification in that order.`)
}

function isMode(value: string | undefined): value is Mode {
  return modes.some((mode) => mode === value)
}

async function runCommand(specification: MaintenanceCommand) {
  console.log(`\n## ${specification.label}`)
  const child = Bun.spawn([...specification.command], {
    cwd: specification.cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    console.error(`${specification.label} exited with status ${exitCode}`)
  }
  return exitCode
}

async function run(mode: Mode) {
  const selected = mode === "all" ? [...commands.inventory, ...commands.audit, ...commands.verify] : commands[mode]
  const failures: string[] = []
  for (const specification of selected) {
    if ((await runCommand(specification)) !== 0) failures.push(specification.label)
  }
  return failures
}

const mode = Bun.argv[2]
if (mode === "--help" || mode === "-h") {
  printUsage()
} else if (!isMode(mode)) {
  printUsage()
  process.exitCode = 2
} else {
  const failures = await run(mode)
  if (failures.length > 0) {
    console.error(`\nDependency maintenance reported failures: ${failures.join(", ")}`)
    process.exitCode = 1
  }
}
