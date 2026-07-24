// ── Engagement-Scoped Ghidra Runtime ─────────────────────────────
// Starts one networkless headless Ghidra service for an engagement, preserves
// its host-owned project store, and reaps service and bridge containers.
// → cyberful/src/session/prompt.ts — shares this runtime across sequential phases.
// → cyberful/src/subsystem/upstream.ts — creates one disposable bridge per phase.
// @docs/runtimes/ghidra.md
// ─────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import { BoundedByteTail } from "@/util/bounded-output"
import { dockerOwnershipLabels } from "@/util/container-ownership"
import {
  cyberGhidraBridgeCommand,
  cyberGhidraBridgeImage,
  cyberGhidraImage,
  cyberGhidraStartupTimeoutSeconds,
  shouldEnableCyberGhidra,
} from "@/dependency/config"

const log = Log.create({ service: "ghidra-runtime" })
const started = new Set<string>()
const DOCKER_TIMEOUT_MS = 60_000
const DOCKER_OUTPUT_BYTES = 128 * 1024
const DOCKER_KILL_GRACE_MS = 1_000
const BRIDGE_DIAGNOSTIC_BYTES = 64 * 1024
const BRIDGE_TIMEOUT_MS = 30_000
const EXIT_CLEANUP_TIMEOUT_MS = 5_000
let exitHookInstalled = false
let liveListener: ((containers: string[]) => void) | undefined

export interface EngagementRuntime {
  readonly env: Record<string, string>
  readonly degraded: boolean
  readonly warning?: string
  readonly stop: () => Promise<void>
}

function slug(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-36)
}

function secret() {
  return randomBytes(32).toString("base64url")
}

function dockerEnv(env: Record<string, string>) {
  return Object.fromEntries(
    [...Object.entries(process.env), ...Object.entries(env)].filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

async function docker(command: string[], options: { env?: Record<string, string>; signal?: AbortSignal } = {}) {
  const deadline = AbortSignal.timeout(DOCKER_TIMEOUT_MS)
  const abort = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const result = await Process.run(command, {
    env: dockerEnv(options.env ?? {}),
    abort,
    timeout: DOCKER_KILL_GRACE_MS,
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_BYTES,
  })
  const stderr = result.stderr.toString("utf8").trim()
  if (result.code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${result.code}: ${stderr}`)
  return result.stdout.toString("utf8").trim()
}

function notifyLive() {
  liveListener?.([...started])
}

function remember(container: string) {
  started.add(container)
  notifyLive()
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", removeStartedSync)
}

export function onLiveChange(listener: (containers: string[]) => void) {
  liveListener = listener
  notifyLive()
}

async function relatedBridges(container: string) {
  return (
    await docker([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=org.cyberful.ghidra-container=${container}`,
    ])
  )
    .split("\n")
    .filter(Boolean)
}

async function removeContainer(container: string) {
  const result = await Process.run(["docker", "rm", "--force", "--volumes", container], {
    timeout: DOCKER_KILL_GRACE_MS,
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_BYTES,
    abort: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
  })
  const stderr = result.stderr.toString("utf8")
  if (result.code !== 0 && !stderr.includes("No such container"))
    throw new Error(`Docker could not remove Ghidra container ${container}: ${stderr.trim()}`)
  if (started.delete(container)) notifyLive()
}

async function stop(container: string) {
  const failures: unknown[] = []
  try {
    for (const bridge of await relatedBridges(container)) {
      try {
        await removeContainer(bridge)
      } catch (error) {
        failures.push(error)
      }
    }
  } catch (error) {
    failures.push(error)
  }
  try {
    await removeContainer(container)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw new AggregateError(failures, `Ghidra runtime cleanup failed for ${container}`)
}

function removeStartedSync() {
  for (const container of started) {
    const related = Bun.spawnSync(
      ["docker", "ps", "--all", "--quiet", "--filter", `label=org.cyberful.ghidra-container=${container}`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: EXIT_CLEANUP_TIMEOUT_MS },
    )
    if (related.exitCode === 0)
      for (const bridge of new TextDecoder().decode(related.stdout).split("\n").filter(Boolean))
        Bun.spawnSync(["docker", "rm", "--force", "--volumes", bridge], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: EXIT_CLEANUP_TIMEOUT_MS,
        })
    Bun.spawnSync(["docker", "rm", "--force", "--volumes", container], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: EXIT_CLEANUP_TIMEOUT_MS,
    })
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms))
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function waitUntilHealthy(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + cyberGhidraStartupTimeoutSeconds() * 1000
  while (Date.now() < deadline) {
    const state = await docker(
      [
        "docker",
        "inspect",
        "--format",
        "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
        container,
      ],
      { signal },
    )
    if (state === "true healthy") return
    if (!state.startsWith("true ")) throw new Error("the headless Ghidra container exited during startup")
    if (state === "true unhealthy") throw new Error("the headless Ghidra health check failed")
    await sleep(500, signal)
  }
  throw new Error(`timed out after ${cyberGhidraStartupTimeoutSeconds()}s waiting for the Ghidra JVM`)
}

async function probeBridge(command: string[], env: Record<string, string>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const [executable, ...args] = command
  const transport = new StdioClientTransport({
    command: executable,
    args,
    env: dockerEnv(env),
    stderr: "pipe",
  })
  const diagnostics = new BoundedByteTail(BRIDGE_DIAGNOSTIC_BYTES)
  const capture = (chunk: Buffer) => diagnostics.append(chunk)
  transport.stderr?.on("data", capture)
  const client = new Client({ name: "cyberful-ghidra-preflight", version: "0.1.0" })
  const deadline = AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline
  const abort = () => void client.close().catch(() => undefined)
  cancellation.addEventListener("abort", abort, { once: true })
  try {
    await client.connect(transport)
    cancellation.throwIfAborted()
    const tools = await client.listTools(undefined, { timeout: 20_000, maxTotalTimeout: 20_000 })
    const names = new Set(tools.tools.map((tool) => tool.name))
    for (const required of ["ghidra_project", "ghidra_import", "ghidra_decompile", "ghidra_call_graph"])
      if (!names.has(required)) throw new Error(`Ghidra MCP is missing required tool ${required}`)
  } catch (error) {
    const detail = diagnostics.text().trim()
    throw new Error(detail ? `${errorMessage(error)}\nGhidra bridge stderr:\n${detail}` : errorMessage(error), {
      cause: error,
    })
  } finally {
    cancellation.removeEventListener("abort", abort)
    transport.stderr?.off("data", capture)
    await client.close().catch(() => undefined)
  }
}

function currentUser() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined
  if (uid === undefined || gid === undefined) return
  if (uid === 0) throw new Error("Cyberful refuses to run the persistent Ghidra store as root")
  return `${uid}:${gid}`
}

export async function startEngagement(input: {
  readonly sessionID: string
  readonly workarea: string
  readonly store: string
  readonly signal?: AbortSignal
}): Promise<EngagementRuntime> {
  input.signal?.throwIfAborted()
  if (!shouldEnableCyberGhidra()) return { env: {}, degraded: false, stop: () => Promise.resolve() }

  const session = slug(input.sessionID)
  const container = `cyberful-ghidra-${session}-${randomBytes(4).toString("hex")}`
  const mcpKey = secret()
  const runtimeEnv = { CYBER_GHIDRA_MCP_KEY: mcpKey }
  const ownershipLabels = dockerOwnershipLabels({ managed: "ghidra", runtime: "ghidra", session })
  const user = currentUser()
  remember(container)
  try {
    await docker(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        container,
        ...ownershipLabels.flatMap((label) => ["--label", label]),
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "4",
        "--memory",
        "4g",
        "--pids-limit",
        "512",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=1g",
        ...(user ? ["--user", user] : []),
        "--mount",
        `type=bind,source=${input.workarea},target=/workspace,readonly`,
        "--mount",
        `type=bind,source=${input.store},target=/ghidra/store`,
        "--env",
        "CYBER_GHIDRA_MCP_KEY",
        cyberGhidraImage(),
      ],
      { env: runtimeEnv, signal: input.signal },
    )
    await waitUntilHealthy(container, input.signal)
    const env = {
      ...runtimeEnv,
      CYBER_GHIDRA_CONTAINER: container,
      CYBER_GHIDRA_BRIDGE_IMAGE: cyberGhidraBridgeImage(),
    }
    const preflightBridge = `cyberful-ghidra-bridge-${session}-preflight-${randomBytes(3).toString("hex")}`
    try {
      await probeBridge(
        cyberGhidraBridgeCommand({
          container,
          name: preflightBridge,
          session,
          ownerPID: process.pid,
        }),
        env,
        input.signal,
      )
    } finally {
      await removeContainer(preflightBridge)
    }
    log.info("headless Ghidra engagement runtime ready", { container, store: input.store })
    return { env, degraded: false, stop: () => stop(container) }
  } catch (error) {
    let cleanupError: unknown
    try {
      await stop(container)
    } catch (failure) {
      cleanupError = failure
    }
    if (input.signal?.aborted) throw input.signal.reason
    const warning = [
      `Headless Ghidra unavailable; binary analysis tools are disabled: ${errorMessage(error)}`,
      cleanupError ? `Ghidra container cleanup also failed: ${errorMessage(cleanupError)}` : undefined,
    ]
      .filter(Boolean)
      .join(" ")
    log.warn(warning)
    return { env: {}, degraded: true, warning, stop: () => Promise.resolve() }
  }
}

export async function removeAll() {
  const outcomes = await Promise.allSettled([...started].map(stop))
  const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
  if (failures.length > 0) throw new AggregateError(failures, "one or more Ghidra runtimes could not be removed")
}

export * as SubsystemGhidraRuntime from "./runtime"
