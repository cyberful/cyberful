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
import { rm } from "node:fs/promises"
import { and, eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { SessionVariableTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { SessionVariable } from "@/session/variable"

export const EVM_RUNTIME_LABEL = "org.cyberful.evm-runtime"
export const EVM_VARIABLE_DESCRIPTION_PREFIX = "Cyberful EVM lab account; runtime="
const OUTPUT_LIMIT = 128 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const started = new Map<string, { readonly sessionID: string; readonly workarea: string }>()
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

async function cleanup(runtimeID: string, input: { readonly sessionID: string; readonly workarea: string }) {
  const failures: unknown[] = []
  try {
    await removeContainers(runtimeID)
  } catch (error) {
    failures.push(error)
  }
  try {
    removeSyntheticVariables(input.sessionID, runtimeID)
  } catch (error) {
    failures.push(error)
  }
  for (const directory of ["cache", "projects"]) {
    try {
      await rm(path.join(input.workarea, ".cyberful-evm", directory), { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  started.delete(runtimeID)
  if (failures.length > 0) throw new AggregateError(failures, "EVM engagement cleanup failed")
}

function removeStartedSync() {
  for (const runtimeID of started.keys()) {
    const found = Bun.spawnSync(
      ["docker", "ps", "--all", "--quiet", "--filter", `label=${EVM_RUNTIME_LABEL}=${runtimeID}`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3_000, maxBuffer: OUTPUT_LIMIT },
    )
    if (found.exitCode !== 0) continue
    for (const id of new TextDecoder().decode(found.stdout).split("\n").filter(Boolean))
      Bun.spawnSync(["docker", "rm", "--force", "--volumes", id], {
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
}): Promise<EngagementRuntime> {
  const runtimeID = randomUUID()
  started.set(runtimeID, input)
  installExitHook()
  return {
    env: { CYBERFUL_EVM_RUNTIME_ID: runtimeID },
    stop: () => cleanup(runtimeID, input),
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
