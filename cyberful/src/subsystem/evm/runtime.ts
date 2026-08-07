// ── Engagement-Owned EVM Runtime ────────────────────────────────────────────
// Gives every Bug Bounty engagement one opaque Docker ownership identity. A
// phase gateway may create the managed Anvil container, while this parent owner
// reaps every matching container and isolated compiler cache at every terminal
// path. No JSON-RPC proxy or method policy exists in this runtime.
// → cyberful/src/subsystem/gateway/evm-lab.ts — creates and operates Anvil.
// @docs/runtimes/evm.md
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises"
import { and, eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SessionVariableTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { SessionVariable } from "@/session/variable"

export const EVM_RUNTIME_LABEL = "org.cyberful.evm-runtime"
export const EVM_VARIABLE_DESCRIPTION_PREFIX = "Cyberful EVM lab account; runtime="
const OUTPUT_LIMIT = 128 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const EVM_DIRECTORY = ".cyberful-evm"
const RUNTIME_DIRECTORIES = ["cache", "projects"] as const

interface EvmEngagementInput {
  readonly sessionID: string
  readonly workarea: string
  readonly container: string
}

const started = new Map<string, EvmEngagementInput>()
let exitHookInstalled = false

export interface EngagementRuntime {
  readonly env: Record<string, string>
  readonly stop: () => Promise<void>
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function boundedText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (retained >= OUTPUT_LIMIT) continue
    const chunk = next.value.subarray(0, OUTPUT_LIMIT - retained)
    chunks.push(chunk)
    retained += chunk.byteLength
  }
  const output = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

export async function dockerCommand(args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      boundedText(child.stdout),
      boundedText(child.stderr),
    ])
    if (timedOut) throw new Error(`docker ${args.slice(0, 2).join(" ")} timed out`)
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function containerIDs(result: CommandResult) {
  if (result.exitCode !== 0) throw new Error(`Docker inventory failed: ${result.stderr.trim()}`)
  return result.stdout.split("\n").map((item) => item.trim()).filter(Boolean)
}

async function removeContainers(runtimeID: string) {
  const ids = containerIDs(
    await dockerCommand(["ps", "--all", "--quiet", "--filter", `label=${EVM_RUNTIME_LABEL}=${runtimeID}`]),
  )
  const failures: string[] = []
  for (const id of ids) {
    const removed = await dockerCommand(["rm", "--force", "--volumes", id])
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) failures.push(removed.stderr.trim())
  }
  if (failures.length > 0) throw new Error(`EVM runtime cleanup failed: ${failures.join("; ")}`)
}

async function removeNetworks(runtimeID: string) {
  const ids = containerIDs(
    await dockerCommand(["network", "ls", "--quiet", "--filter", `label=${EVM_RUNTIME_LABEL}=${runtimeID}`]),
  )
  const failures: string[] = []
  for (const id of ids) {
    const removed = await dockerCommand(["network", "rm", id])
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such network")) failures.push(removed.stderr.trim())
  }
  if (failures.length > 0) throw new Error(`EVM network cleanup failed: ${failures.join("; ")}`)
}

export function evmVariableRegistryName(runtimeID: string) {
  return SessionVariable.Name.make(`_cyberful_host_evm_${runtimeID.replaceAll("-", "")}_variables`)
}

function removeSyntheticVariables(sessionID: string, runtimeID: string) {
  const marker = `${EVM_VARIABLE_DESCRIPTION_PREFIX}${runtimeID}`
  const boundSession = SessionID.make(sessionID)
  const registry = evmVariableRegistryName(runtimeID)
  Database.transaction((db) => {
    const row = db
      .select({ value: SessionVariableTable.value })
      .from(SessionVariableTable)
      .where(and(eq(SessionVariableTable.session_id, boundSession), eq(SessionVariableTable.name, registry)))
      .get()
    const names = Array.isArray(row?.value)
      ? row.value.filter((value): value is string => typeof value === "string")
      : []
    for (const name of names)
      db
        .delete(SessionVariableTable)
        .where(and(eq(SessionVariableTable.session_id, boundSession), eq(SessionVariableTable.name, name)))
        .run()
    db
      .delete(SessionVariableTable)
      .where(
        and(
          eq(SessionVariableTable.session_id, boundSession),
          eq(SessionVariableTable.description, marker),
        ),
      )
      .run()
    db
      .delete(SessionVariableTable)
      .where(and(eq(SessionVariableTable.session_id, boundSession), eq(SessionVariableTable.name, registry)))
      .run()
  })
}

// ── Compiler State Is Container-Local But Engagement-Owned ─────────────────
// The host creates and validates the cache root without changing its own HOME.
// Forge writes through the `/workspace` mount and may create root-owned nested
// files, so terminal cleanup first deletes content from the still-live core
// container and then removes the host directories on every terminal path.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureRuntimeDirectory(workarea: string) {
  const canonicalWorkarea = await realpath(workarea)
  const runtimeRoot = path.join(canonicalWorkarea, EVM_DIRECTORY)
  await mkdir(runtimeRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const rootMetadata = await lstat(runtimeRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("EVM runtime root must be a plain workarea directory")
  if (path.dirname(await realpath(runtimeRoot)) !== canonicalWorkarea)
    throw new Error("EVM runtime root escapes the workarea")
  const cache = path.join(runtimeRoot, "cache")
  await mkdir(cache, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const cacheMetadata = await lstat(cache)
  if (!cacheMetadata.isDirectory() || cacheMetadata.isSymbolicLink())
    throw new Error("EVM compiler cache must be a plain directory")
  if (path.dirname(await realpath(cache)) !== runtimeRoot) throw new Error("EVM compiler cache escapes its runtime root")
  await Promise.all([chmod(runtimeRoot, 0o700), chmod(cache, 0o700)])
  return canonicalWorkarea
}

async function clearRuntimeDirectories(input: EvmEngagementInput) {
  const privileged = await dockerCommand([
    "exec",
    input.container,
    "find",
    ...RUNTIME_DIRECTORIES.map((directory) => `/workspace/${EVM_DIRECTORY}/${directory}`),
    "-mindepth",
    "1",
    "-delete",
  ]).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
  const failures: unknown[] = []
  for (const directory of RUNTIME_DIRECTORIES) {
    try {
      await rm(path.join(input.workarea, EVM_DIRECTORY, directory), { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    if (privileged.exitCode !== 0) failures.unshift(new Error(`privileged EVM cleanup failed: ${privileged.stderr.trim()}`))
    throw new AggregateError(failures, "EVM workarea cleanup failed")
  }
}

async function cleanup(runtimeID: string, input: EvmEngagementInput) {
  const failures: unknown[] = []
  try {
    await removeContainers(runtimeID)
  } catch (error) {
    failures.push(error)
  }
  try {
    await removeNetworks(runtimeID)
  } catch (error) {
    failures.push(error)
  }
  try {
    removeSyntheticVariables(input.sessionID, runtimeID)
  } catch (error) {
    failures.push(error)
  }
  try {
    await clearRuntimeDirectories(input)
  } catch (error) {
    failures.push(error)
  }
  started.delete(runtimeID)
  if (failures.length > 0) throw new AggregateError(failures, "EVM engagement cleanup failed")
}

function removeStartedSync() {
  for (const [runtimeID, input] of started) {
    Bun.spawnSync(
      [
        "docker",
        "exec",
        input.container,
        "find",
        ...RUNTIME_DIRECTORIES.map((directory) => `/workspace/${EVM_DIRECTORY}/${directory}`),
        "-mindepth",
        "1",
        "-delete",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 3_000 },
    )
    const found = Bun.spawnSync(
      ["docker", "ps", "--all", "--quiet", "--filter", `label=${EVM_RUNTIME_LABEL}=${runtimeID}`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3_000, maxBuffer: OUTPUT_LIMIT },
    )
    if (found.exitCode === 0)
      for (const id of new TextDecoder().decode(found.stdout).split("\n").filter(Boolean))
        Bun.spawnSync(["docker", "rm", "--force", "--volumes", id], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: 3_000,
        })
    const networks = Bun.spawnSync(
      ["docker", "network", "ls", "--quiet", "--filter", `label=${EVM_RUNTIME_LABEL}=${runtimeID}`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3_000, maxBuffer: OUTPUT_LIMIT },
    )
    if (networks.exitCode !== 0) continue
    for (const id of new TextDecoder().decode(networks.stdout).split("\n").filter(Boolean))
      Bun.spawnSync(["docker", "network", "rm", id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 3_000,
      })
  }
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", removeStartedSync)
}

export async function startEngagement(input: {
  readonly sessionID: string
  readonly workarea: string
  readonly container: string
}): Promise<EngagementRuntime> {
  if (!input.container.trim()) throw new Error("EVM runtime requires the engagement-owned cyberful-os container")
  const workarea = await ensureRuntimeDirectory(input.workarea)
  const runtimeID = randomUUID()
  const engagement = { ...input, workarea }
  started.set(runtimeID, engagement)
  installExitHook()
  return {
    env: { CYBERFUL_EVM_RUNTIME_ID: runtimeID },
    stop: () => cleanup(runtimeID, engagement),
  }
}

export async function removeAll() {
  const failures: unknown[] = []
  for (const [runtimeID, input] of [...started]) {
    try {
      await cleanup(runtimeID, input)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "one or more EVM runtimes could not be removed")
}

export * as SubsystemEvmRuntime from "./runtime"
