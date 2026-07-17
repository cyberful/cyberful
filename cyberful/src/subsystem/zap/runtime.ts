// ── Engagement-Scoped ZAP Runtime ────────────────────────────────
// Starts one headless ZAP service for an engagement, distributes only its opaque
// connection descriptor to phase gateways, and reaps service and bridge containers.
// → cyberful/src/subsystem/orchestrator.ts — shares this runtime across sequential phases.
// → cyberful/src/util/bounded-output.ts — bounds bridge startup diagnostics.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import { createHash, randomBytes, X509Certificate } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import { BoundedByteTail } from "@/util/bounded-output"
import {
  cyberZapBridgeImage,
  cyberZapBridgeCommand,
  cyberZapImage,
  cyberZapProxyPort,
  cyberZapStartupTimeoutSeconds,
  shouldChainBrowserThroughZap,
  shouldEnableCyberZap,
} from "@/dependency/config"

const log = Log.create({ service: "zap-runtime" })
const started = new Set<string>()
const CLEANUP_CONCURRENCY = 8
const DOCKER_COMMAND_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_WAIT_TIMEOUT_MS = 1_500
const DOCKER_KILL_GRACE_MS = 1_000
const DOCKER_OUTPUT_LIMIT_BYTES = 128 * 1024
const DOCKER_EXIT_CLEANUP_TIMEOUT_MS = 5_000
const BRIDGE_PREFLIGHT_TIMEOUT_MS = 30_000
const BRIDGE_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024
let exitHookInstalled = false
let liveListener: ((containers: string[]) => void) | undefined

type CleanupOutcome = { failed: false } | { failed: true; error: unknown }

export interface EngagementRuntime {
  env: Record<string, string>
  degraded: boolean
  warning?: string
  stop: () => Promise<void>
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

function slug(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-36)
}

function secret() {
  return randomBytes(32).toString("base64url")
}

export function localTargetWarning(objective: string) {
  const target = objective
    .match(/https?:\/\/[^\s<>()"']+/gi)
    ?.map((value) => {
      try {
        return new URL(value.replace(/[.,;:!?]+$/, ""))
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return undefined
      }
    })
    .find((value) => value && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(value.hostname))
  if (!target) return
  const corrected = new URL(target)
  corrected.hostname = "host.docker.internal"
  return (
    `The target ${target.origin} is host loopback, which resolves inside the ZAP container. ` +
    `Use ${corrected.origin} when that preserves the application's Host, cookie, redirect, and origin semantics; ` +
    "Cyberful will not rewrite it automatically."
  )
}

function dockerEnv(env: Record<string, string>) {
  return Object.fromEntries(
    [...Object.entries(process.env), ...Object.entries(env)].filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

class DockerCommandTimeoutError extends Error {
  constructor(command: readonly string[], timeoutMs: number) {
    super(`${command.slice(0, 3).join(" ")} timed out after ${timeoutMs}ms`)
    this.name = "DockerCommandTimeoutError"
  }
}

interface DockerCommandOptions {
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("ZAP Docker command aborted", { cause: signal.reason })
}

// ── Docker Commands Have One Bounded Owner ──────────────────────
// ZAP startup and cleanup issue short host-side Docker commands whose output is
// untrusted process data. One adapter caps both streams, applies a wall deadline,
// links engagement cancellation, and escalates termination before returning.
// Every path awaits the process and pipe readers, so cancellation, timeout, and
// oversized output cannot leave a detached Docker client behind.
// ─────────────────────────────────────────────────────────────────
async function runDockerCommand(command: string[], options: DockerCommandOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal ? abortError(options.signal) : new Error("Aborted"))
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  const deadline = setTimeout(() => controller.abort(new DockerCommandTimeoutError(command, timeoutMs)), timeoutMs)
  deadline.unref()
  try {
    const result = await Process.run(command, {
      env: dockerEnv(options.env ?? {}),
      abort: controller.signal,
      timeout: DOCKER_KILL_GRACE_MS,
      nothrow: true,
      maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
    })
    if (controller.signal.aborted) throw abortError(controller.signal)
    return result
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener("abort", abort)
  }
}

async function commandOutput(command: string[], options: DockerCommandOptions = {}) {
  const result = await runDockerCommand(command, options)
  const stderr = result.stderr.toString("utf8").trim()
  if (result.code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${result.code}: ${stderr}`)
  return result.stdout.toString("utf8").trim()
}

async function removeContainer(container: string) {
  const result = await runDockerCommand(["docker", "rm", "--force", "--volumes", container], {
    timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS,
  })
  const stderr = result.stderr.toString("utf8")
  if (result.code !== 0 && !stderr.includes("No such container"))
    throw new Error(`Docker could not remove ZAP container ${container} (exit ${result.code}): ${stderr.trim()}`)
  if (started.delete(container)) notifyLive()
}

async function cleanupFailures<T>(items: readonly T[], operation: (item: T) => Promise<void>) {
  const failures: unknown[] = []
  for (let offset = 0; offset < items.length; offset += CLEANUP_CONCURRENCY) {
    const outcomes = await Promise.all(
      items.slice(offset, offset + CLEANUP_CONCURRENCY).map(async (item): Promise<CleanupOutcome> => {
        try {
          await operation(item)
          return { failed: false }
        } catch (error) {
          return { failed: true, error }
        }
      }),
    )
    for (const outcome of outcomes) if (outcome.failed) failures.push(outcome.error)
  }
  return failures
}

function rememberContainer(container: string) {
  started.add(container)
  notifyLive()
  installExitHook()
}

function notifyLive() {
  liveListener?.([...started])
}

export function onLiveChange(listener: (containers: string[]) => void) {
  liveListener = listener
  notifyLive()
}

function removeStartedSync() {
  Array.from(started).forEach((container) => {
    const related = Bun.spawnSync(
      ["docker", "ps", "--all", "--quiet", "--filter", `label=org.cyberful.zap-container=${container}`],
      {
        stdout: "pipe",
        stderr: "ignore",
        timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
        maxBuffer: DOCKER_OUTPUT_LIMIT_BYTES,
      },
    )
    if (related.exitCode === 0) {
      new TextDecoder()
        .decode(related.stdout)
        .trim()
        .split("\n")
        .filter(Boolean)
        .forEach((bridge) => {
          Bun.spawnSync(["docker", "rm", "--force", "--volumes", bridge], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
          })
        })
    }
    Bun.spawnSync(["docker", "rm", "--force", "--volumes", container], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: DOCKER_EXIT_CLEANUP_TIMEOUT_MS,
    })
  })
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", removeStartedSync)
}

export function parsePublishedPort(value: string) {
  const port = Number.parseInt(
    value
      .trim()
      .split("\n")[0]
      ?.match(/:(\d+)$/)?.[1] ?? "",
    10,
  )
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) throw new Error(`invalid ZAP proxy mapping: ${value}`)
  return port
}

export function spkiFromCertificate(value: Uint8Array) {
  const certificate = new X509Certificate(value)
  const publicKey = certificate.publicKey.export({ type: "spki", format: "der" })
  return createHash("sha256").update(publicKey).digest("base64")
}

async function waitForApi(proxyUrl: string, apiKey: string, container: string, signal?: AbortSignal) {
  const deadline = Date.now() + cyberZapStartupTimeoutSeconds() * 1000
  let lastProbeError: unknown
  while (Date.now() < deadline) {
    let response: Response | undefined
    try {
      response = await fetch(`${proxyUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(apiKey)}`, {
        headers: { Host: "zap" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      })
      if (!response.ok) lastProbeError = new Error(`ZAP readiness returned HTTP ${response.status}`)
    } catch (error) {
      signal?.throwIfAborted()
      lastProbeError = error
    }
    if (response?.ok) return
    const running = await commandOutput(["docker", "inspect", "--format", "{{.State.Running}}", container], {
      signal,
    })
    if (running !== "true") throw new Error("the headless ZAP container exited during startup")
    await sleep(500, signal)
  }
  throw new Error(`timed out after ${cyberZapStartupTimeoutSeconds()}s waiting for the ZAP API`, {
    cause: lastProbeError,
  })
}

async function probeBridge(command: string[], env: Record<string, string>, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal)
  const [executable, ...args] = command
  const transport = new StdioClientTransport({ command: executable, args, env: dockerEnv(env), stderr: "pipe" })
  const client = new Client({ name: "cyberful-zap-preflight", version: "0.1.0" })
  const diagnostics = new BoundedByteTail(BRIDGE_DIAGNOSTIC_LIMIT_BYTES)
  const captureDiagnostic = (chunk: Buffer) => diagnostics.append(chunk)
  transport.stderr?.on("data", captureDiagnostic)

  // ── Bridge Preflight Retains Primary And Cleanup Failures ─────
  // The MCP connect call may wait on stdio when its caller aborts, so the abort
  // callback initiates one retained close task. A fixed deadline uses the same
  // path when no engagement signal exists. stderr is drained into a finite tail
  // and appears only on failure, keeping successful startup protocol-clean.
  // Primary and close errors are aggregated after both settle, so finalization
  // cannot replace the reason preflight failed or create an unhandled rejection.
  // ─────────────────────────────────────────────────────────────────
  type CloseOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  let closeOutcome: Promise<CloseOutcome> | undefined
  const startClose = () => {
    if (closeOutcome) return
    let task: Promise<void>
    try {
      task = client.close()
    } catch (error) {
      task = Promise.reject(error)
    }
    closeOutcome = task.then(
      (): CloseOutcome => ({ ok: true }),
      (error): CloseOutcome => ({ ok: false, error }),
    )
  }
  const close = async () => {
    startClose()
    const outcome = await closeOutcome
    if (outcome && !outcome.ok) throw outcome.error
  }
  const deadline = AbortSignal.timeout(BRIDGE_PREFLIGHT_TIMEOUT_MS)
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline
  const abort = startClose
  cancellation.addEventListener("abort", abort, { once: true })
  let primaryFailure: unknown
  try {
    await client.connect(transport)
    if (cancellation.aborted) throw abortError(cancellation)
    const tools = await client.listTools(undefined, { timeout: 20_000, maxTotalTimeout: 20_000 })
    if (cancellation.aborted) throw abortError(cancellation)
    if (!tools.tools.some((tool) => tool.name === "zap_version")) throw new Error("official ZAP MCP tools are missing")
  } catch (error) {
    primaryFailure = error
  }
  cancellation.removeEventListener("abort", abort)
  let cleanupFailure: unknown
  try {
    await close()
  } catch (error) {
    cleanupFailure = error
  } finally {
    transport.stderr?.off("data", captureDiagnostic)
  }

  const diagnostic = diagnostics.text().trim()
  const withDiagnostic = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(errorMessage(error))
    if (!diagnostic) return failure
    const omitted = diagnostics.truncated ? `[${diagnostics.droppedBytes} earlier diagnostic bytes omitted]\n` : ""
    return new Error(`${failure.message}\nZAP bridge stderr:\n${omitted}${diagnostic}`, { cause: failure })
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError(
      [withDiagnostic(primaryFailure), withDiagnostic(cleanupFailure)],
      "ZAP MCP preflight and cleanup both failed",
    )
  if (primaryFailure !== undefined) throw withDiagnostic(primaryFailure)
  if (cleanupFailure !== undefined) throw withDiagnostic(cleanupFailure)
}

async function certificateSpki(proxyUrl: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch(`${proxyUrl}/OTHER/core/other/rootcert/?apikey=${encodeURIComponent(apiKey)}`, {
    headers: { Host: "zap" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`ZAP root CA export returned HTTP ${response.status}`)
  return spkiFromCertificate(new Uint8Array(await response.arrayBuffer()))
}

async function removeSessionBridges(session: string) {
  const containers = (
    await commandOutput([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=org.cyberful.managed=zap-bridge",
      "--filter",
      `label=org.cyberful.session=${session}`,
    ])
  )
    .split("\n")
    .filter(Boolean)
  const failures = await cleanupFailures(containers, removeContainer)
  if (failures.length > 0) throw new AggregateError(failures, `could not remove ZAP bridges for ${session}`)
}

async function stop(container: string, proxyUrl: string, apiKey: string, session: string) {
  const failures: unknown[] = []
  try {
    await removeSessionBridges(session)
  } catch (error) {
    failures.push(error)
  }
  try {
    await fetch(`${proxyUrl}/JSON/core/action/shutdown/?apikey=${encodeURIComponent(apiKey)}`, {
      headers: { Host: "zap" },
      signal: AbortSignal.timeout(2000),
    })
  } catch (error) {
    log.warn("ZAP graceful shutdown request failed; forcing container removal", { container, error })
  }
  try {
    await commandOutput(["docker", "wait", container], { timeoutMs: DOCKER_WAIT_TIMEOUT_MS })
  } catch (error) {
    if (!(error instanceof DockerCommandTimeoutError)) {
      log.warn("ZAP container wait failed; forcing container removal", { container, error })
    }
  }
  try {
    await removeContainer(container)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw new AggregateError(failures, "ZAP runtime cleanup failed")
}

export async function removeAll() {
  const failures = await cleanupFailures([...started], async (container) => {
    const failures: unknown[] = []
    try {
      const related = (
        await commandOutput([
          "docker",
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=org.cyberful.zap-container=${container}`,
        ])
      )
        .split("\n")
        .filter(Boolean)
      for (const bridge of related) {
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
    if (failures.length > 0) throw new AggregateError(failures, `could not remove ZAP runtime ${container}`)
  })
  if (failures.length > 0) throw new AggregateError(failures, "one or more ZAP runtimes could not be removed")
}

export async function startEngagement(input: {
  sessionID: string
  workarea: string
  objective?: string
  signal?: AbortSignal
}): Promise<EngagementRuntime> {
  input.signal?.throwIfAborted()
  if (!shouldEnableCyberZap()) return { env: {}, degraded: false, stop: () => Promise.resolve() }

  const targetWarning = localTargetWarning(input.objective ?? "")
  const session = slug(input.sessionID)
  const container = `cyberful-zap-${slug(input.sessionID)}-${randomBytes(4).toString("hex")}`
  const apiKey = secret()
  const mcpKey = secret()
  const runtimeEnv = { CYBER_ZAP_API_KEY: apiKey, CYBER_ZAP_MCP_KEY: mcpKey }
  const published = cyberZapProxyPort() ? `127.0.0.1:${cyberZapProxyPort()}:8080` : "127.0.0.1::8080"

  rememberContainer(container)
  try {
    await commandOutput(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        container,
        "--label",
        "org.cyberful.managed=zap",
        "--label",
        `org.cyberful.session=${session}`,
        "--label",
        `org.cyberful.owner-pid=${process.pid}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--publish",
        published,
        "--mount",
        "type=volume,target=/home/zap/.ZAP",
        "--mount",
        `type=bind,source=${input.workarea},target=/zap/wrk`,
        "--env",
        "CYBER_ZAP_API_KEY",
        "--env",
        "CYBER_ZAP_MCP_KEY",
        cyberZapImage(),
      ],
      { env: runtimeEnv, signal: input.signal },
    )

    const proxyUrl = `http://127.0.0.1:${parsePublishedPort(
      await commandOutput(["docker", "port", container, "8080/tcp"], { signal: input.signal }),
    )}`
    await waitForApi(proxyUrl, apiKey, container, input.signal)
    const spki = await certificateSpki(proxyUrl, apiKey, input.signal)
    const env = {
      ...runtimeEnv,
      CYBER_ZAP_CONTAINER: container,
      CYBER_ZAP_PROXY_URL: proxyUrl,
      CYBER_ZAP_WORKAREA: input.workarea,
      CYBER_ZAP_BRIDGE_IMAGE: cyberZapBridgeImage(),
      ...(shouldChainBrowserThroughZap() ? { CYBER_BROWSER_PROXY: proxyUrl, CYBER_BROWSER_PROXY_CA_SPKI: spki } : {}),
    }
    const preflightBridge = `cyberful-zap-bridge-${session}-preflight-${randomBytes(3).toString("hex")}`
    rememberContainer(preflightBridge)
    try {
      await probeBridge(
        cyberZapBridgeCommand(input.workarea, {
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
    log.info("headless ZAP engagement runtime ready", { container, proxyUrl })
    return { env, degraded: false, warning: targetWarning, stop: () => stop(container, proxyUrl, apiKey, session) }
  } catch (error) {
    let cleanupError: unknown
    try {
      await removeContainer(container)
    } catch (failure) {
      cleanupError = failure
    }
    if (input.signal?.aborted) throw input.signal.reason
    const warning = [
      `OWASP ZAP unavailable; browser traffic will use the direct fallback: ${errorMessage(error)}`,
      cleanupError ? `ZAP container cleanup also failed: ${errorMessage(cleanupError)}` : undefined,
      targetWarning,
    ]
      .filter(Boolean)
      .join(" ")
    log.warn(warning)
    return {
      env: { CYBER_BROWSER_PROXY_WARNING: warning },
      degraded: true,
      warning,
      stop: () => Promise.resolve(),
    }
  }
}

export * as SubsystemZapRuntime from "./runtime"
