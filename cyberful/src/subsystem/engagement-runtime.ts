// ── Unified Engagement Runtime Ownership ─────────────────────────
// Starts and owns the single cyberful-os container shared by every phase, with
//   optional ZAP and Ghidra services selected before Docker creates it.
// → cyberful/src/session/prompt.ts — scopes this owner to one workflow run.
// → mcps/cyberful-os/runtime_supervisor.py — supervises the in-container services.
// @docs/concepts/execution-model.md
// @docs/runtimes/cyberful-os.md
// ─────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  cyberGhidraBridgeCommand,
  cyberGhidraStartupTimeoutSeconds,
  cyberfulOsImage,
  cyberZapBridgeCommand,
  cyberZapProxyPort,
  cyberZapStartupTimeoutSeconds,
  shouldChainBrowserThroughZap,
  shouldEnableCyberGhidra,
  shouldEnableCyberZap,
} from "@/dependency/config"
import { errorMessage } from "@/util/error"
import * as Log from "@/util/log"
import { Process } from "@/util/process"
import { BoundedByteTail } from "@/util/bounded-output"
import { dockerOwnershipLabels } from "@/util/container-ownership"
import { SubsystemContainer } from "./container"
import { applyEngagementRateLimit, readEngagementPolicy } from "./gateway/engagement-policy"
import { localTargetWarning, parsePublishedPort, spkiFromCertificate } from "./zap/runtime"

const log = Log.create({ service: "engagement-runtime" })
const DOCKER_COMMAND_TIMEOUT_MS = 60_000
const DOCKER_OUTPUT_LIMIT_BYTES = 128 * 1024
const DOCKER_KILL_GRACE_MS = 1_000
const BRIDGE_PREFLIGHT_TIMEOUT_MS = 30_000
const BRIDGE_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024

export interface EngagementRuntime {
  readonly container: string
  readonly env: Record<string, string>
  readonly degraded: boolean
  readonly warnings: readonly string[]
  readonly stop: () => Promise<void>
}

interface DockerOptions {
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
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

async function docker(command: string[], options: DockerOptions = {}) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS)
  const abort = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const result = await Process.run(command, {
    env: dockerEnv(options.env ?? {}),
    abort,
    timeout: DOCKER_KILL_GRACE_MS,
    nothrow: true,
    maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
  })
  const stderr = result.stderr.toString("utf8").trim()
  if (result.code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${result.code}: ${stderr}`)
  return result.stdout.toString("utf8").trim()
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

function runtimeIdentity() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined
  return {
    uid: uid !== undefined && uid > 0 ? uid : 1000,
    gid: gid !== undefined && gid > 0 ? gid : 1000,
  }
}

async function waitForContainer(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await docker(["docker", "inspect", "--format", "{{.State.Running}}", container], { signal })
    if (state === "true") return
    await sleep(250, signal)
  }
  throw new Error("the unified engagement container did not become ready")
}

async function waitForZap(proxyUrl: string, apiKey: string, container: string, signal?: AbortSignal) {
  const deadline = Date.now() + cyberZapStartupTimeoutSeconds() * 1000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${proxyUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(apiKey)}`, {
        headers: { Host: "zap" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
      })
      if (response.ok) return
      lastError = new Error(`ZAP readiness returned HTTP ${response.status}`)
    } catch (error) {
      signal?.throwIfAborted()
      lastError = error
    }
    const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", container], { signal })
    if (running !== "true") throw new Error("the unified engagement container exited during ZAP startup")
    await sleep(500, signal)
  }
  throw new Error(`timed out after ${cyberZapStartupTimeoutSeconds()}s waiting for the ZAP API`, {
    cause: lastError,
  })
}

async function waitForGhidra(container: string, signal?: AbortSignal) {
  const deadline = Date.now() + cyberGhidraStartupTimeoutSeconds() * 1000
  while (Date.now() < deadline) {
    const result = await Process.run(
      ["docker", "exec", container, "/opt/cyberful-os-venv/bin/python", "/opt/cyberful/ghidra/healthcheck.py"],
      {
        env: dockerEnv({}),
        abort: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000),
        timeout: DOCKER_KILL_GRACE_MS,
        nothrow: true,
        maxOutputBytes: DOCKER_OUTPUT_LIMIT_BYTES,
      },
    )
    if (result.code === 0) return
    const running = await docker(["docker", "inspect", "--format", "{{.State.Running}}", container], { signal })
    if (running !== "true") throw new Error("the unified engagement container exited during Ghidra startup")
    await sleep(500, signal)
  }
  throw new Error(`timed out after ${cyberGhidraStartupTimeoutSeconds()}s waiting for the Ghidra JVM`)
}

async function certificateSpki(proxyUrl: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch(`${proxyUrl}/OTHER/core/other/rootcert/?apikey=${encodeURIComponent(apiKey)}`, {
    headers: { Host: "zap" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`ZAP root CA export returned HTTP ${response.status}`)
  return spkiFromCertificate(new Uint8Array(await response.arrayBuffer()))
}

async function probeBridge(input: {
  readonly name: "zap" | "ghidra"
  readonly command: string[]
  readonly env: Record<string, string>
  readonly requiredTools: readonly string[]
  readonly signal?: AbortSignal
}) {
  const [command, ...args] = input.command
  if (!command) throw new Error(`${input.name} bridge command is unavailable`)
  const transport = new StdioClientTransport({
    command,
    args,
    env: dockerEnv(input.env),
    stderr: "pipe",
  })
  const diagnostics = new BoundedByteTail(BRIDGE_DIAGNOSTIC_LIMIT_BYTES)
  const capture = (chunk: Buffer) => diagnostics.append(chunk)
  transport.stderr?.on("data", capture)
  const client = new Client({ name: `cyberful-${input.name}-preflight`, version: "0.1.0" })
  const deadline = AbortSignal.timeout(BRIDGE_PREFLIGHT_TIMEOUT_MS)
  const cancellation = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const abort = () => void client.close().catch(() => undefined)
  cancellation.addEventListener("abort", abort, { once: true })
  try {
    await client.connect(transport)
    cancellation.throwIfAborted()
    const tools = await client.listTools(undefined, { timeout: 20_000, maxTotalTimeout: 20_000 })
    const names = new Set(tools.tools.map((tool) => tool.name))
    for (const required of input.requiredTools)
      if (!names.has(required)) throw new Error(`${input.name} MCP is missing required tool ${required}`)
  } catch (error) {
    const detail = diagnostics.text().trim()
    throw new Error(detail ? `${errorMessage(error)}\n${input.name} bridge stderr:\n${detail}` : errorMessage(error), {
      cause: error,
    })
  } finally {
    cancellation.removeEventListener("abort", abort)
    transport.stderr?.off("data", capture)
    await client.close().catch(() => undefined)
  }
}

async function verifyCore(container: string, signal?: AbortSignal) {
  await docker(
    [
      "docker",
      "exec",
      container,
      "/opt/cyberful-os-venv/bin/python",
      "/opt/cyberful/runtime-attestation",
    ],
    { signal, timeoutMs: 120_000 },
  )
}

// ── Network Authority Is Fixed At Container Creation ────────────
// Code Audit starts this same image with Docker networking disabled and never
// starts ZAP. Live-target workflows publish only ZAP's proxy on host loopback.
// No phase may mutate those choices later, so sequential gateways reconnect to
// one stable container without offline/online suffixes or privilege escalation.
// The workarea remains writable by design; Ghidra alone also receives its store.
// ─────────────────────────────────────────────────────────────────
export async function startEngagement(input: {
  readonly sessionID: string
  readonly workflow: string
  readonly container: string
  readonly workarea: string
  readonly ghidraStore?: string
  readonly objective?: string
  readonly signal?: AbortSignal
  readonly onDiagnostic?: (input: {
    readonly component: "zap" | "ghidra"
    readonly severity: "warning" | "error"
    readonly errorClass: string
    readonly message: string
  }) => void
}): Promise<EngagementRuntime> {
  input.signal?.throwIfAborted()
  const codeAudit = input.workflow === "code-audit"
  const policy = await readEngagementPolicy(input.workarea)
  const zapEnabled = !codeAudit && shouldEnableCyberZap()
  const ghidraEnabled = Boolean(input.ghidraStore) && shouldEnableCyberGhidra()
  if (!zapEnabled && policy?.global_http_rps !== null && policy?.global_http_rps !== undefined)
    throw new Error("OWASP ZAP cannot be disabled while the engagement defines a global HTTP rate limit")

  const apiKey = zapEnabled ? secret() : undefined
  const zapMcpKey = zapEnabled ? secret() : undefined
  const ghidraMcpKey = ghidraEnabled ? secret() : undefined
  const serviceEnv = {
    CYBERFUL_ZAP_ENABLED: zapEnabled ? "1" : "0",
    CYBERFUL_GHIDRA_ENABLED: ghidraEnabled ? "1" : "0",
    ...(apiKey ? { CYBER_ZAP_API_KEY: apiKey } : {}),
    ...(zapMcpKey ? { CYBER_ZAP_MCP_KEY: zapMcpKey } : {}),
    ...(ghidraMcpKey ? { CYBER_GHIDRA_MCP_KEY: ghidraMcpKey } : {}),
  }
  const identity = runtimeIdentity()
  const published = cyberZapProxyPort() ? `127.0.0.1:${cyberZapProxyPort()}:8080` : "127.0.0.1::8080"
  const ownershipLabels = dockerOwnershipLabels({
    managed: "engagement",
    runtime: "cyberful-os",
    session: input.sessionID,
  })

  SubsystemContainer.remember(input.container)
  await SubsystemContainer.reap(input.container)
  try {
    await docker(
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        input.container,
        "--hostname",
        input.container,
        "--workdir",
        "/workspace",
        ...ownershipLabels.flatMap((label) => ["--label", label]),
        "--cap-add=NET_ADMIN",
        "--cap-add=SYS_PTRACE",
        "--pids-limit=2048",
        ...(codeAudit ? ["--network", "none"] : ["--add-host", "host.docker.internal:host-gateway"]),
        ...(zapEnabled ? ["--publish", published] : []),
        "--mount",
        `type=bind,source=${input.workarea},target=/workspace`,
        ...(zapEnabled
          ? ["--mount", `type=bind,source=${input.workarea},target=/zap/wrk`]
          : []),
        ...(ghidraEnabled && input.ghidraStore
          ? ["--mount", `type=bind,source=${input.ghidraStore},target=/ghidra/store`]
          : []),
        "--env",
        `CYBERFUL_RUNTIME_UID=${identity.uid}`,
        "--env",
        `CYBERFUL_RUNTIME_GID=${identity.gid}`,
        ...Object.keys(serviceEnv).flatMap((name) => ["--env", name]),
        cyberfulOsImage(),
      ],
      { env: serviceEnv, signal: input.signal },
    )
    await waitForContainer(input.container, input.signal)
    await verifyCore(input.container, input.signal)
  } catch (error) {
    await SubsystemContainer.remove(input.container).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], "unified engagement runtime startup and cleanup failed")
    })
    throw error
  }

  const env: Record<string, string> = {
    CYBERFUL_OS_CONTAINER: input.container,
    CYBERFUL_OS_IMAGE: cyberfulOsImage(),
    CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER: "1",
    ...(policy?.global_http_rps !== null && policy?.global_http_rps !== undefined
      ? { CYBER_ZAP_REQUIRED_BY_RATE_LIMIT: "1" }
      : {}),
  }
  const warnings: string[] = []
  let degraded = false
  let proxyUrl: string | undefined

  if (zapEnabled && apiKey && zapMcpKey) {
    try {
      proxyUrl = `http://127.0.0.1:${parsePublishedPort(
        await docker(["docker", "port", input.container, "8080/tcp"], { signal: input.signal }),
      )}`
      await waitForZap(proxyUrl, apiKey, input.container, input.signal)
      if (policy)
        await applyEngagementRateLimit(policy, {
          proxyUrl,
          apiKey,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      const spki = await certificateSpki(proxyUrl, apiKey, input.signal)
      Object.assign(env, {
        CYBER_ZAP_READY: "1",
        CYBER_ZAP_API_KEY: apiKey,
        CYBER_ZAP_MCP_KEY: zapMcpKey,
        CYBER_ZAP_PROXY_URL: proxyUrl,
        CYBER_ZAP_WORKAREA: input.workarea,
        ...(shouldChainBrowserThroughZap()
          ? { CYBER_BROWSER_PROXY: proxyUrl, CYBER_BROWSER_PROXY_CA_SPKI: spki }
          : {}),
      })
      await probeBridge({
        name: "zap",
        command: cyberZapBridgeCommand(input.container),
        env,
        requiredTools: ["zap_version"],
        ...(input.signal ? { signal: input.signal } : {}),
      })
      const targetWarning = localTargetWarning(input.objective ?? "")
      if (targetWarning) warnings.push(targetWarning)
    } catch (error) {
      input.signal?.throwIfAborted()
      input.onDiagnostic?.({
        component: "zap",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "ZapStartupError" : "ZapStartupError",
        message: errorMessage(error),
      })
      if (policy?.global_http_rps !== null && policy?.global_http_rps !== undefined) {
        await SubsystemContainer.remove(input.container)
        throw new Error(`OWASP ZAP is required by the global HTTP rate limit: ${errorMessage(error)}`, {
          cause: error,
        })
      }
      degraded = true
      const warning = `OWASP ZAP unavailable; browser traffic will use the direct fallback: ${errorMessage(error)}`
      warnings.push(warning)
      env.CYBER_BROWSER_PROXY_WARNING = warning
    }
  }

  if (ghidraEnabled && ghidraMcpKey) {
    try {
      await waitForGhidra(input.container, input.signal)
      Object.assign(env, { CYBER_GHIDRA_READY: "1", CYBER_GHIDRA_MCP_KEY: ghidraMcpKey })
      await probeBridge({
        name: "ghidra",
        command: cyberGhidraBridgeCommand(input.container),
        env,
        requiredTools: ["ghidra_project", "ghidra_import", "ghidra_decompile", "ghidra_call_graph"],
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (error) {
      input.signal?.throwIfAborted()
      input.onDiagnostic?.({
        component: "ghidra",
        severity: "error",
        errorClass: error instanceof Error ? error.name || "GhidraStartupError" : "GhidraStartupError",
        message: errorMessage(error),
      })
      degraded = true
      warnings.push(`Headless Ghidra unavailable; binary analysis tools are disabled: ${errorMessage(error)}`)
    }
  }

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (proxyUrl && apiKey)
      await fetch(`${proxyUrl}/JSON/core/action/shutdown/?apikey=${encodeURIComponent(apiKey)}`, {
        headers: { Host: "zap" },
        signal: AbortSignal.timeout(2_000),
      }).catch((error) => log.warn("ZAP graceful shutdown failed; removing unified runtime", { error }))
    await SubsystemContainer.remove(input.container)
  }
  log.info("unified engagement runtime ready", {
    container: input.container,
    codeAudit,
    zap: env.CYBER_ZAP_READY === "1",
    ghidra: env.CYBER_GHIDRA_READY === "1",
  })
  return { container: input.container, env, degraded, warnings, stop }
}

export * as SubsystemEngagementRuntime from "./engagement-runtime"
