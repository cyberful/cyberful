// ── Subsystem Version Update Transaction ────────────────────────
// Discovers, installs, verifies, and persists one registered subsystem version
// while keeping repository pins unchanged until its live contract succeeds.
// → cyberful/script/subsystems.ts — supplies subsystem-specific release adapters.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, rename, rm, stat } from "node:fs/promises"

export type CommandOutput = "capture" | "inherit"

export type CommandSpec = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly output: CommandOutput
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>>
}

export type CommandResult = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (command: CommandSpec) => Promise<CommandResult>

export type ManagedSubsystem = {
  readonly name: string
  readonly pinnedVersion: string
  readonly availableVersionCommand: CommandSpec
  readonly installedVersionCommand: CommandSpec
  readonly functionalPinFiles: readonly string[]
  readonly parseAvailableVersion: (result: CommandResult) => string
  readonly parseInstalledVersion: (result: CommandResult) => string | null
  readonly installCommand: (version: string) => CommandSpec
  readonly compatibilityCommand: (version: string) => CommandSpec
}

export type UpdateSubsystemOptions = {
  readonly repositoryRoot: string
  readonly runCommand?: CommandRunner
  readonly log?: (message: string) => void
}

type PinChange = {
  readonly path: string
  readonly source: string
  readonly updated: string
  readonly mode: number
  readonly temporaryPath: string
}

const MAX_CAPTURE_BYTES = 1024 * 1024

function commandText(command: CommandSpec) {
  return command.argv.join(" ")
}

export const runCommand: CommandRunner = async (command) => {
  try {
    const environment = { ...process.env, ...command.env }
    if (command.output === "inherit") {
      const result = Bun.spawnSync([...command.argv], {
        cwd: command.cwd,
        env: environment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: command.timeoutMs,
      })
      return { exitCode: result.exitCode, stdout: "", stderr: "" }
    }

    const result = Bun.spawnSync([...command.argv], {
      cwd: command.cwd,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: command.timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
    })
    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout).toString("utf8"),
      stderr: Buffer.from(result.stderr).toString("utf8"),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: null, stdout: "", stderr: message }
  }
}

function requireSuccess(command: CommandSpec, result: CommandResult) {
  if (result.exitCode === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(`${commandText(command)} exited with ${result.exitCode ?? "no status"}${detail ? `: ${detail}` : ""}`)
}

function occurrenceCount(source: string, value: string) {
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(value, offset)) >= 0) {
    count++
    offset += value.length
  }
  return count
}

// ── Declared Pins Form The Commit Boundary ──────────────────────
// Every adapter inventories only runtime and CI artifacts whose exact version
// changes application or verification behavior. Documentation is deliberately
// excluded: its presence, location, and prose can never gate maintenance or be
// rewritten as a side effect. The transaction validates all functional pins
// before changing the host, then replaces them only after compatibility passes.
// A partial filesystem failure restores every captured original before returning.
// ─────────────────────────────────────────────────────────────────
function isDocumentationPath(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase()
  return (
    normalized === "readme.md" ||
    normalized.startsWith("docs/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx") ||
    normalized.endsWith(".rst")
  )
}

async function preparePinChanges(
  repositoryRoot: string,
  subsystem: ManagedSubsystem,
  availableVersion: string,
): Promise<PinChange[]> {
  if (!subsystem.pinnedVersion.trim()) throw new Error(`${subsystem.name} has an empty pinned version`)
  if (!availableVersion.trim()) throw new Error(`${subsystem.name} returned an empty available version`)
  if (subsystem.functionalPinFiles.length === 0) {
    throw new Error(`${subsystem.name} declares no functional version pin files`)
  }
  const documentationPins = subsystem.functionalPinFiles.filter(isDocumentationPath)
  if (documentationPins.length > 0) {
    throw new Error(`${subsystem.name} functional pins must not include documentation: ${documentationPins.join(", ")}`)
  }

  const root = path.resolve(repositoryRoot)
  const token = crypto.randomUUID()
  return Promise.all(
    subsystem.functionalPinFiles.map(async (relativePath) => {
      const filePath = path.resolve(root, relativePath)
      if (filePath === root || !filePath.startsWith(root + path.sep)) {
        throw new Error(`${subsystem.name} pin escapes the repository: ${relativePath}`)
      }
      const [source, metadata] = await Promise.all([Bun.file(filePath).text(), stat(filePath)])
      const occurrences = occurrenceCount(source, subsystem.pinnedVersion)
      if (occurrences === 0) {
        throw new Error(`${relativePath} does not contain the ${subsystem.name} pin ${subsystem.pinnedVersion}`)
      }
      return {
        path: filePath,
        source,
        updated: source.replaceAll(subsystem.pinnedVersion, availableVersion),
        mode: metadata.mode,
        temporaryPath: `${filePath}.cyberful-pin-${token}.tmp`,
      }
    }),
  )
}

async function restorePins(changes: readonly PinChange[]) {
  const restored = await Promise.allSettled(
    changes.map(async (change) => {
      await Bun.write(change.path, change.source)
      await chmod(change.path, change.mode)
    }),
  )
  const failures = restored.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length > 0) throw new AggregateError(failures, "Unable to restore subsystem version pins")
}

async function persistPins(changes: readonly PinChange[]) {
  const prepared = await Promise.allSettled(
    changes.map(async (change) => {
      await Bun.write(change.temporaryPath, change.updated)
      await chmod(change.temporaryPath, change.mode)
    }),
  )
  const preparationFailures = prepared.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (preparationFailures.length > 0) {
    await Promise.allSettled(changes.map((change) => rm(change.temporaryPath, { force: true })))
    throw new AggregateError(preparationFailures, "Unable to prepare subsystem version pins")
  }

  const replacements = await Promise.allSettled(changes.map((change) => rename(change.temporaryPath, change.path)))
  const replacementFailures = replacements.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (replacementFailures.length === 0) return

  const cleanup = Promise.allSettled(changes.map((change) => rm(change.temporaryPath, { force: true })))
  try {
    await restorePins(changes)
  } catch (error) {
    throw new AggregateError([...replacementFailures, error], "Subsystem pin replacement and rollback failed")
  } finally {
    await cleanup
  }
  throw new AggregateError(replacementFailures, "Subsystem pin replacement failed; original pins were restored")
}

async function restoreInstalledVersion(
  subsystem: ManagedSubsystem,
  previousVersion: string,
  execute: CommandRunner,
  log: (message: string) => void,
) {
  log(`  ↩ restoring ${subsystem.name} ${previousVersion}`)
  const install = subsystem.installCommand(previousVersion)
  requireSuccess(install, await execute(install))
  const probe = await execute(subsystem.installedVersionCommand)
  requireSuccess(subsystem.installedVersionCommand, probe)
  const restoredVersion = subsystem.parseInstalledVersion(probe)
  if (restoredVersion !== previousVersion) {
    throw new Error(
      `restored ${subsystem.name} reports ${restoredVersion ?? "no version"}, expected ${previousVersion}`,
    )
  }
}

// ── Compatibility Authorizes Persistence ────────────────────────
// Release discovery is only a candidate selection; it never changes the pin by
// itself. The candidate executable must report the discovered version and pass
// the adapter's real compatibility command before repository files move. When
// installation changed an existing executable, any later failure reinstalls
// and re-probes that previous version. A missing prior executable is left
// installed for diagnosis because the updater cannot prove ownership of it.
// ─────────────────────────────────────────────────────────────────
export async function updateSubsystem(subsystem: ManagedSubsystem, options: UpdateSubsystemOptions) {
  const execute = options.runCommand ?? runCommand
  const log = options.log ?? console.log

  log(`\n▸ ${subsystem.name}: discovering the available version`)
  const availableResult = await execute(subsystem.availableVersionCommand)
  requireSuccess(subsystem.availableVersionCommand, availableResult)
  const availableVersion = subsystem.parseAvailableVersion(availableResult)
  log(`  available ${availableVersion}; pinned ${subsystem.pinnedVersion}`)

  const changes = await preparePinChanges(options.repositoryRoot, subsystem, availableVersion)
  const installedResult = await execute(subsystem.installedVersionCommand)
  const previousVersion = subsystem.parseInstalledVersion(installedResult)
  const installationChanged = previousVersion !== availableVersion

  try {
    if (installationChanged) {
      log(`  installing ${subsystem.name} ${availableVersion}`)
      const install = subsystem.installCommand(availableVersion)
      requireSuccess(install, await execute(install))
    } else {
      log(`  installed version already matches ${availableVersion}`)
    }

    const probe = await execute(subsystem.installedVersionCommand)
    requireSuccess(subsystem.installedVersionCommand, probe)
    const installedVersion = subsystem.parseInstalledVersion(probe)
    if (installedVersion !== availableVersion) {
      throw new Error(
        `${subsystem.name} reports ${installedVersion ?? "no version"} after installation, expected ${availableVersion}`,
      )
    }

    log(`  verifying ${subsystem.name} ${availableVersion} compatibility`)
    const compatibility = subsystem.compatibilityCommand(availableVersion)
    requireSuccess(compatibility, await execute(compatibility))

    if (availableVersion !== subsystem.pinnedVersion) {
      await persistPins(changes)
      log(`  pinned ${subsystem.name} ${availableVersion} in ${changes.length} files`)
    } else {
      log(`  repository already pins ${availableVersion}`)
    }
    log(`✓ ${subsystem.name} ${availableVersion} is installed, compatible, and pinned`)
    return availableVersion
  } catch (error) {
    if (!installationChanged || previousVersion === null) throw error
    try {
      await restoreInstalledVersion(subsystem, previousVersion, execute, log)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${subsystem.name} update and installation rollback failed`)
    }
    throw new Error(`${subsystem.name} update failed; the previous installation was restored`, { cause: error })
  }
}
