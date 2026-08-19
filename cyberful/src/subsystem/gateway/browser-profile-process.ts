// ── Browser Hub And Controller Processes ────────────────────────────
// Launches the profile-owning Chromium hub, validates its readiness record and
// loopback CDP endpoint, then connects AgentRun-scoped MCP controllers with the
// hub's immutable proxy attestation. No controller can terminate the hub.
// → cyberful/src/subsystem/gateway/browser-profile-hub.ts — owns lifecycle policy.
// → mcps/browser/browser_mcp.mjs — implements EAGER and OWN_TAB modes.
// @docs/runtimes/browser.md
// ────────────────────────────────────────────────────────────────────

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { cdpPortListening, readCdpPort } from "../browser-cdp"
import { BrowserProfileHub } from "./browser-profile-hub"

const HUB_READY_TIMEOUT_MS = 30_000
const HUB_EXIT_GRACE_MS = 2_000
const MAX_READY_LINE_BYTES = 64 * 1024

interface BrowserProfileProcessOptions {
  readonly label: string
  readonly command: readonly [string, ...string[]]
  readonly environment: Readonly<Record<string, string>>
  readonly profileDir: string
  readonly diagnosticSink?: (text: string) => void
  readonly ownProcess: (pid: number) => void
}

interface BrowserHubReady {
  readonly type: "cyberful-browser-ready"
  readonly version: 1
  readonly proxy: {
    readonly configured: boolean
    readonly mode: "direct" | "zap" | "direct-fallback"
    readonly warning: string | null
  }
  readonly runtime: {
    readonly requested_channel: string | null
    readonly resolved_channel: string | null
    readonly executable_path: string | null
    readonly version: string | null
    readonly driver: string | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseHubReady(line: string): BrowserHubReady {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.type !== "cyberful-browser-ready" || value.version !== 1)
    throw new Error("browser hub emitted an invalid readiness envelope")
  const proxy = value.proxy
  const runtime = value.runtime
  if (!isRecord(proxy) || !isRecord(runtime)) throw new Error("browser hub readiness is incomplete")
  if (typeof proxy.configured !== "boolean" || !["direct", "zap", "direct-fallback"].includes(String(proxy.mode)))
    throw new Error("browser hub readiness has an invalid proxy attestation")
  if (proxy.warning !== null && typeof proxy.warning !== "string")
    throw new Error("browser hub readiness has an invalid proxy warning")
  for (const key of ["requested_channel", "resolved_channel", "executable_path", "version", "driver"] as const) {
    if (runtime[key] !== null && typeof runtime[key] !== "string")
      throw new Error(`browser hub readiness has invalid runtime.${key}`)
  }
  return value as unknown as BrowserHubReady
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let body = ""
  const deadline = AbortSignal.timeout(HUB_READY_TIMEOUT_MS)
  const aborted = new Promise<never>((_resolve, reject) => {
    deadline.addEventListener(
      "abort",
      () => reject(new DOMException("browser hub readiness timed out", "TimeoutError")),
      { once: true },
    )
  })
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted])
      if (result.done) throw new Error("browser hub exited before readiness")
      body += decoder.decode(result.value, { stream: true })
      if (Buffer.byteLength(body) > MAX_READY_LINE_BYTES) throw new Error("browser hub readiness line is oversized")
      const newline = body.indexOf("\n")
      if (newline >= 0) return body.slice(0, newline).trim()
    }
  } finally {
    reader.releaseLock()
  }
}

async function drainDiagnostics(stream: ReadableStream<Uint8Array>, sink?: (text: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      const text = decoder.decode(value, { stream: true })
      if (!text) continue
      if (sink) sink(text)
      else process.stderr.write(text)
    }
  } catch {
    // Process shutdown can close the pipe while a diagnostic read is pending.
  } finally {
    reader.releaseLock()
  }
}

async function stopProcess(processHandle: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (processHandle.exitCode !== null) return
  processHandle.kill("SIGTERM")
  let exited = false
  await Promise.race([
    processHandle.exited.then(() => {
      exited = true
    }),
    new Promise<void>((resolve) => setTimeout(resolve, HUB_EXIT_GRACE_MS)),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill("SIGKILL")
    await processHandle.exited
  }
}

function controllerEnvironment(base: Readonly<Record<string, string>>, endpoint: string, attestation: string) {
  const environment = { ...base }
  delete environment.CYBER_BROWSER_EAGER
  environment.CYBER_BROWSER_CDP_ENDPOINT = endpoint
  environment.CYBER_BROWSER_OWN_TAB = "1"
  environment.CYBER_BROWSER_SHARED_ATTESTATION = attestation
  return environment
}

async function connectClient(
  options: BrowserProfileProcessOptions,
  environment: Readonly<Record<string, string>>,
  onClose: () => void = () => undefined,
) {
  const [command, ...args] = options.command
  const transport = new StdioClientTransport({ command, args, env: { ...environment }, stderr: "pipe" })
  if (options.diagnosticSink) {
    transport.stderr?.on("data", (chunk: Buffer) => options.diagnosticSink?.(chunk.toString("utf8")))
  }
  const client = new Client({ name: "expert-gateway", version: "0.1.0" })
  client.onclose = onClose
  await client.connect(transport)
  if (transport.pid !== null) options.ownProcess(transport.pid)
  return { client, close: () => client.close() }
}

export async function browserToolCatalog(options: BrowserProfileProcessOptions): Promise<readonly Tool[]> {
  const environment = { ...options.environment }
  delete environment.CYBER_BROWSER_EAGER
  delete environment.CYBER_BROWSER_CDP_ENDPOINT
  delete environment.CYBER_BROWSER_OWN_TAB
  delete environment.CYBER_BROWSER_SHARED_ATTESTATION
  const connection = await connectClient(options, environment)
  try {
    return (await connection.client.listTools()).tools
  } finally {
    await connection.close()
  }
}

export function createBrowserProfileProcess(options: BrowserProfileProcessOptions): BrowserProfileHub<Client> {
  return new BrowserProfileHub<Client>({
    label: options.label,
    cancellationGraceMs: 2_250,
    probeTimeoutMs: 5_000,
    connectHub: async () => {
      const [command, ...args] = options.command
      const environment: Record<string, string> = { ...options.environment, CYBER_BROWSER_EAGER: "1" }
      delete environment.CYBER_BROWSER_CDP_ENDPOINT
      delete environment.CYBER_BROWSER_OWN_TAB
      delete environment.CYBER_BROWSER_SHARED_ATTESTATION
      const processHandle = Bun.spawn([command, ...args], {
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      options.ownProcess(processHandle.pid)
      void drainDiagnostics(processHandle.stderr, options.diagnosticSink)
      try {
        const ready = parseHubReady(await firstLine(processHandle.stdout))
        const port = await readCdpPort(options.profileDir)
        if (!port) throw new Error(`${options.label} hub did not publish a live loopback CDP port`)
        let closed = false
        return {
          endpoint: `http://127.0.0.1:${port}`,
          attestation: JSON.stringify(ready),
          alive: async () => !closed && processHandle.exitCode === null && cdpPortListening(port),
          close: async () => {
            if (closed) return
            closed = true
            await stopProcess(processHandle)
          },
        }
      } catch (error) {
        await stopProcess(processHandle).catch(() => undefined)
        throw error
      }
    },
    connectController: async (hub, onClose) => {
      const connection = await connectClient(
        options,
        controllerEnvironment(options.environment, hub.endpoint, hub.attestation),
        onClose,
      )
      return { value: connection.client, close: connection.close }
    },
    probeController: async (client, signal) => {
      await client.listTools(undefined, { signal })
    },
  })
}
