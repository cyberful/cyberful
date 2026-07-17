// ── Live ZAP Engagement Contract Tests ──────────────────────────
// Exercises real headless ZAP and bridge containers, proxy capture, scoped MCP
// operations, authentication, shared state, and deterministic cleanup.
// → cyberful/src/subsystem/zap/runtime.ts — owns the tested engagement lifecycle.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { cyberZapBridgeImage } from "@/dependency/config"
import { run } from "@/util/process"
import { startEngagement, type EngagementRuntime } from "./runtime"
import { SubsystemGateway } from "../gateway/config"
import { SubsystemCli } from "../cli"

const runtimes: EngagementRuntime[] = []
const clients: Client[] = []
let workarea = ""
let target: ReturnType<typeof Bun.serve>
let httpsTarget: ReturnType<typeof Bun.serve>
let upstreamDiagnostics = ""
let restoreStderr = () => {}

function captureDiagnostic(value: string) {
  upstreamDiagnostics = `${upstreamDiagnostics}${value}`.slice(-64 * 1024)
}

function pipeDiagnostics(transport: StdioClientTransport) {
  transport.stderr?.on("data", (chunk: Buffer) => captureDiagnostic(chunk.toString("utf8")))
  return transport
}

function bridge(
  runtime: EngagementRuntime,
  mcpKey = runtime.env.CYBER_ZAP_MCP_KEY,
  stderr: "pipe" | "ignore" = "pipe",
) {
  const command = [
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--network",
    `container:${runtime.env.CYBER_ZAP_CONTAINER}`,
    "--mount",
    `type=bind,source=${workarea},target=/zap/wrk`,
    "--env",
    "CYBER_ZAP_MCP_KEY",
    "--env",
    "CYBER_ZAP_API_KEY",
    "--env",
    "CYBER_ZAP_WORKAREA=/zap/wrk",
    cyberZapBridgeImage(),
  ]
  const transport = new StdioClientTransport({
    command: "docker",
    args: command,
    stderr,
    env: {
      PATH: process.env.PATH ?? "",
      CYBER_ZAP_MCP_KEY: mcpKey,
      CYBER_ZAP_API_KEY: runtime.env.CYBER_ZAP_API_KEY,
    },
  })
  return stderr === "pipe" ? pipeDiagnostics(transport) : transport
}

async function connect(runtime: EngagementRuntime) {
  const client = new Client({ name: "cyberful-zap-integration", version: "0" })
  await client.connect(bridge(runtime))
  clients.push(client)
  return client
}

async function connectBrowser(input: {
  profile: string
  channel?: "chrome" | "chromium"
  proxy?: string
  spki?: string
  warning?: string
  cdpEndpoint?: string
  attestation?: string
}) {
  const client = new Client({ name: "cyberful-browser-integration", version: "0" })
  const command = path.resolve(import.meta.dir, "../../../../mcps/browser/bin/cyber-browser")
  await client.connect(
    pipeDiagnostics(
      new StdioClientTransport({
        command,
        args: [],
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: os.homedir(),
          TMPDIR: os.tmpdir(),
          CYBER_BROWSER_BROWSERS_PATH:
            process.env.CYBER_BROWSER_BROWSERS_PATH ?? path.join(os.homedir(), ".cyberful", "browser", ".browsers"),
          CYBER_BROWSER_CHANNEL: input.channel ?? "chrome",
          CYBER_BROWSER_HEADLESS: "true",
          CYBER_BROWSER_USER_DATA_DIR: path.join(workarea, input.profile),
          CYBER_BROWSER_ARTIFACTS_DIR: path.join(workarea, `${input.profile}-artifacts`),
          ...(input.proxy ? { CYBER_BROWSER_PROXY: input.proxy } : {}),
          ...(input.spki ? { CYBER_BROWSER_PROXY_CA_SPKI: input.spki } : {}),
          ...(input.warning ? { CYBER_BROWSER_PROXY_WARNING: input.warning } : {}),
          ...(input.cdpEndpoint
            ? {
                CYBER_BROWSER_CDP_ENDPOINT: input.cdpEndpoint,
                CYBER_BROWSER_OWN_TAB: "1",
              }
            : {}),
          ...(input.attestation ? { CYBER_BROWSER_SHARED_ATTESTATION: input.attestation } : {}),
        },
      }),
    ),
  )
  clients.push(client)
  return client
}

async function cleanupOperations(message: string, operations: ReadonlyArray<() => void | Promise<void>>) {
  const failures: unknown[] = []
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message)
}

async function closeConnectedClients() {
  await cleanupOperations(
    "one or more ZAP integration clients failed to close",
    clients.splice(0).map((client) => () => client.close()),
  )
}

async function stopRuntimes(...values: EngagementRuntime[]) {
  try {
    await cleanupOperations(
      "one or more ZAP integration runtimes failed to stop",
      values.map((runtime) => runtime.stop),
    )
  } finally {
    for (const runtime of values) {
      const index = runtimes.indexOf(runtime)
      if (index >= 0) runtimes.splice(index, 1)
    }
  }
}

async function releaseRuntimes(...values: EngagementRuntime[]) {
  await cleanupOperations("ZAP integration release failed", [closeConnectedClients, () => stopRuntimes(...values)])
}

function textContent(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  )
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("ZAP bridge returned an incompatible tool result")
  }
  const block = result.content.find(textContent)
  if (!block) throw new Error("ZAP bridge returned no text result")
  return block.text
}

function jsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} did not return valid JSON`, { cause: error })
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function resultRecord(result: Awaited<ReturnType<Client["callTool"]>>, label: string) {
  return recordValue(jsonValue(resultText(result), label), label)
}

function resultArray(result: Awaited<ReturnType<Client["callTool"]>>, label: string) {
  return arrayValue(jsonValue(resultText(result), label), label)
}

function optionalArray(value: unknown, label: string) {
  return value === undefined ? [] : arrayValue(value, label)
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

async function waitForTool(input: {
  client: Client
  name: string
  arguments?: Record<string, unknown>
  done: (value: string) => boolean
  deadline: number
}) {
  while (true) {
    const value = resultText(await input.client.callTool({ name: input.name, arguments: input.arguments }))
    if (input.done(value)) return value
    if (Date.now() >= input.deadline) throw new Error(`timed out waiting for ${input.name}: ${value}`)
    await Bun.sleep(500)
  }
}

async function verifyBrowserHttps(channel: "chrome" | "chromium") {
  const runtime = await startEngagement({ sessionID: `integration-browser-${channel}`, workarea })
  runtimes.push(runtime)
  expect(runtime.degraded).toBe(false)
  expect(runtime.env.CYBER_BROWSER_PROXY_CA_SPKI).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  const zapClient = await connect(runtime)
  expect(
    optionalArray(
      resultRecord(
        await zapClient.callTool({ name: "zap_history_search", arguments: { start: 0, count: 100 } }),
        "zap_history_search",
      ).messages,
      "zap_history_search.messages",
    ),
  ).toHaveLength(0)
  const browserClient = await connectBrowser({
    channel,
    profile: `browser-profile-${channel}`,
    proxy: runtime.env.CYBER_BROWSER_PROXY,
    spki: runtime.env.CYBER_BROWSER_PROXY_CA_SPKI,
  })
  // Sequential phases do not inherit Recon's process-bound shared-browser attestation. Their first
  // browser_status must launch only the blank dedicated context and attest ZAP before target traffic.
  const initialBrowserStatus = resultRecord(
    await browserClient.callTool({ name: "browser_status", arguments: {} }),
    "browser_status",
  )
  expect({
    proxy: recordValue(initialBrowserStatus.proxy, "browser_status.proxy"),
    launched: initialBrowserStatus.launched,
  }).toMatchObject({ proxy: { configured: true, mode: "zap" }, launched: true })
  await Bun.sleep(1_500)
  const startupMessages = optionalArray(
    resultRecord(
      await zapClient.callTool({
        name: "zap_history_search",
        arguments: { start: 0, count: 100 },
      }),
      "zap_history_search",
    ).messages,
    "zap_history_search.messages",
  )
  expect(
    startupMessages.map((message) => {
      if (typeof message !== "object" || message === null || !("requestHeader" in message)) return "unknown"
      const header = String(message.requestHeader)
      const host = header.match(/(?:^|\r?\n)Host:\s*([^\r\n]+)/i)?.[1] ?? "unknown"
      const [method = "unknown", target = "/"] = header.split(/\r?\n/, 1)[0]?.split(" ") ?? []
      const pathname = (() => {
        try {
          return new URL(target).pathname
        } catch {
          return target.split("?", 1)[0]
        }
      })()
      return `${method} ${host}${pathname}`
    }),
  ).toEqual([])
  const marker = `${channel}-https-${Date.now()}`
  const navigation = await browserClient.callTool({
    name: "browser_navigate",
    arguments: { url: `https://host.docker.internal:${httpsTarget.port}/${marker}` },
  })
  expect("isError" in navigation && navigation.isError).not.toBe(true)
  const navigatedStatus = resultRecord(
    await browserClient.callTool({ name: "browser_status", arguments: {} }),
    "browser_status",
  )
  expect(recordValue(navigatedStatus.proxy, "browser_status.proxy").mode).toBe("zap")
  await waitForTool({
    client: zapClient,
    name: "zap_history_search",
    arguments: { search: marker },
    done: (value) =>
      optionalArray(recordValue(jsonValue(value, "zap_history_search"), "zap_history_search").messages, "messages")
        .length > 0,
    deadline: Date.now() + 15_000,
  })
  await releaseRuntimes(runtime)
}

async function dockerOutput(...args: string[]) {
  const result = await run(["docker", ...args], {
    abort: AbortSignal.timeout(30_000),
    timeout: 1_000,
    maxOutputBytes: 64 * 1024,
  })
  return result.stdout.toString("utf8").trim()
}

async function waitForDockerFilter(filters: string[], present: boolean, deadline = Date.now() + 15_000) {
  while (true) {
    const output = await dockerOutput("ps", "--all", "--quiet", ...filters.flatMap((filter) => ["--filter", filter]))
    if (Boolean(output) === present) return output
    if (Date.now() >= deadline) throw new Error(`timed out waiting for managed bridge present=${present}`)
    await Bun.sleep(250)
  }
}

beforeAll(async () => {
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    captureDiagnostic(String(chunk))
    return true
  })
  restoreStderr = () => stderrWrite.mockRestore()
  workarea = await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-integration-"))
  const key = path.join(workarea, "target.key")
  const certificate = path.join(workarea, "target.pem")
  await run(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=host.docker.internal",
      "-addext",
      "subjectAltName=DNS:host.docker.internal",
    ],
    {
      abort: AbortSignal.timeout(30_000),
      timeout: 1_000,
      maxOutputBytes: 64 * 1024,
    },
  )
  target = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      return new Response(
        `<html><body>integration target ${url.pathname} ${url.searchParams.get("q") ?? ""}</body></html>`,
        {
          headers: { "Content-Type": "text/html" },
        },
      )
    },
  })
  httpsTarget = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(certificate) },
    fetch: (request) => new Response(`secure integration target ${new URL(request.url).pathname}`),
  })
})

afterAll(async () => {
  try {
    await cleanupOperations("ZAP integration suite cleanup failed", [
      ...clients.splice(0).map((client) => () => client.close()),
      ...runtimes.splice(0).map((runtime) => runtime.stop),
      () => target.stop(true),
      () => httpsTarget.stop(true),
      () => rm(workarea, { recursive: true, force: true }),
    ])
  } finally {
    restoreStderr()
  }
}, 30_000)

describe("real headless ZAP containers", () => {
  test("authenticate API/MCP and expose the complete hybrid surface on loopback only", async () => {
    const runtime = await startEngagement({ sessionID: "integration-surface", workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)

    const published = await dockerOutput("port", runtime.env.CYBER_ZAP_CONTAINER, "8080/tcp")
    expect(published).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(
      await dockerOutput("inspect", "--format", "{{json .NetworkSettings.Ports}}", runtime.env.CYBER_ZAP_CONTAINER),
    ).not.toContain("8282")

    const authenticated = await fetch(
      `${runtime.env.CYBER_ZAP_PROXY_URL}/JSON/core/view/version/?apikey=${encodeURIComponent(runtime.env.CYBER_ZAP_API_KEY)}`,
      { headers: { Host: "zap" } },
    )
    expect(authenticated.ok).toBe(true)
    let unauthenticatedDenied = false
    try {
      const unauthenticated = await fetch(`${runtime.env.CYBER_ZAP_PROXY_URL}/JSON/core/view/version/`, {
        headers: { Host: "zap" },
      })
      unauthenticatedDenied = !unauthenticated.ok
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ECONNRESET") throw error
      unauthenticatedDenied = true
    }
    expect(unauthenticatedDenied).toBe(true)

    const rejectedTransport = bridge(runtime, "wrong-mcp-key", "ignore")
    const rejectedClient = new Client({ name: "wrong-key", version: "0" })
    await expect(rejectedClient.connect(rejectedTransport)).rejects.toBeDefined()
    await rejectedTransport.close()

    const client = await connect(runtime)
    const tools = (await client.listTools()).tools.map((item) => item.name)
    expect(tools).toContain("zap_version")
    for (const name of [
      "zap_api_catalog",
      "zap_api_call",
      "zap_http_request",
      "zap_generate_scoped_report",
      "zap_history_search",
      "zap_history_get",
      "zap_websocket_history",
      "zap_context_auth",
      "zap_oast",
      "zap_prompt_get",
    ])
      expect(tools).toContain(name)

    expect((await client.listResources()).resources.length).toBeGreaterThan(0)
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    expect((await client.listPrompts()).prompts.map((item) => item.name)).toEqual(
      expect.arrayContaining(["zap_baseline_scan", "zap_full_scan"]),
    )
    const catalog = resultArray(await client.callTool({ name: "zap_api_catalog", arguments: {} }), "zap_api_catalog")
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog).not.toContainEqual({ component: "core", type: "action", operation: "shutdown" })
    expect(catalog).not.toContainEqual({ component: "core", type: "action", operation: "sendRequest" })
    const blocked = await client.callTool({
      name: "zap_api_call",
      arguments: { component: "core", type: "action", operation: "shutdown" },
    })
    expect("isError" in blocked && blocked.isError).toBe(true)
    await releaseRuntimes(runtime)
  }, 180_000)

  test("concurrent bridges share one history while separate engagements remain isolated", async () => {
    const [first, second] = await Promise.all([
      startEngagement({ sessionID: "integration-shared", workarea }),
      startEngagement({ sessionID: "integration-isolated", workarea }),
    ])
    runtimes.push(first, second)
    expect(first.degraded).toBe(false)
    expect(second.degraded).toBe(false)
    expect(first.env.CYBER_ZAP_API_KEY).not.toBe(second.env.CYBER_ZAP_API_KEY)
    expect(first.env.CYBER_ZAP_MCP_KEY).not.toBe(second.env.CYBER_ZAP_MCP_KEY)

    const [writer, reader, isolated] = await Promise.all([connect(first), connect(first), connect(second)])
    const marker = `shared-${Date.now()}`
    const targetUrl = `https://host.docker.internal:${httpsTarget.port}/${marker}`
    const ambiguous = await writer.callTool({
      name: "zap_http_request",
      arguments: {
        request:
          `GET /ambiguous-${marker} HTTP/1.1\r\n` +
          `Host: host.docker.internal:${httpsTarget.port}\r\nConnection: close\r\n\r\n`,
      },
    })
    expect("isError" in ambiguous && ambiguous.isError).toBe(true)
    expect(
      optionalArray(
        resultRecord(
          await reader.callTool({ name: "zap_history_search", arguments: { search: `ambiguous-${marker}` } }),
          "zap_history_search",
        ).messages,
        "zap_history_search.messages",
      ),
    ).toHaveLength(0)

    const sent = resultRecord(
      await writer.callTool({
        name: "zap_http_request",
        arguments: {
          request:
            `GET /${marker} HTTP/1.1\r\n` +
            `Host: host.docker.internal:${httpsTarget.port}\r\nConnection: close\r\n\r\n`,
          target_url: targetUrl,
        },
      }),
      "zap_http_request",
    )
    expect(recordValue(sent.cyberful_request_target, "zap_http_request.cyberful_request_target")).toEqual({
      target_url: targetUrl,
      scheme: "https",
      normalized_origin_form: true,
      recorded_url: targetUrl,
    })
    const shared = resultRecord(
      await reader.callTool({ name: "zap_history_search", arguments: { search: marker } }),
      "zap_history_search",
    )
    const separate = resultRecord(
      await isolated.callTool({ name: "zap_history_search", arguments: { search: marker } }),
      "zap_history_search",
    )
    expect(optionalArray(shared.messages, "zap_history_search.messages").length).toBeGreaterThan(0)
    expect(optionalArray(separate.messages, "zap_history_search.messages")).toHaveLength(0)

    const firstContainer = first.env.CYBER_ZAP_CONTAINER
    await releaseRuntimes(first, second)
    const inspect = await run(["docker", "inspect", firstContainer], {
      abort: AbortSignal.timeout(30_000),
      timeout: 1_000,
      maxOutputBytes: 64 * 1024,
      nothrow: true,
    })
    expect(inspect.code).not.toBe(0)
  }, 240_000)

  test("passively and actively scan a local test target and write a report", async () => {
    const runtime = await startEngagement({ sessionID: "integration-scan", workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)
    const client = await connect(runtime)
    const targetUrl = `http://host.docker.internal:${target.port}/scan?q=seed`

    await client.callTool({
      name: "zap_http_request",
      arguments: {
        request:
          `GET ${targetUrl} HTTP/1.1\r\n` + `Host: host.docker.internal:${target.port}\r\nConnection: close\r\n\r\n`,
      },
    })
    const excludedMarker = `excluded-site-${Date.now()}`
    await client.callTool({
      name: "zap_http_request",
      arguments: {
        request:
          `GET /${excludedMarker} HTTP/1.1\r\n` +
          `Host: host.docker.internal:${httpsTarget.port}\r\nConnection: close\r\n\r\n`,
        target_url: `https://host.docker.internal:${httpsTarget.port}/${excludedMarker}`,
      },
    })
    await waitForTool({
      client,
      name: "zap_get_passive_scan_status",
      done: (value) => /(?:^|\D)0(?:\D|$)/.test(value),
      deadline: Date.now() + 30_000,
    })

    await client.callTool({
      name: "zap_api_call",
      arguments: { component: "ascan", type: "action", operation: "disableAllScanners" },
    })
    await client.callTool({
      name: "zap_api_call",
      arguments: {
        component: "ascan",
        type: "action",
        operation: "enableScanners",
        parameters: { ids: "40012" },
      },
    })
    const started = resultRecord(
      await client.callTool({
        name: "zap_api_call",
        arguments: {
          component: "ascan",
          type: "action",
          operation: "scan",
          parameters: { url: targetUrl, recurse: false },
        },
      }),
      "zap_api_call.scan",
    )
    const scanID = stringValue(started.scan, "zap_api_call.scan")
    await waitForTool({
      client,
      name: "zap_api_call",
      arguments: {
        component: "ascan",
        type: "view",
        operation: "status",
        parameters: { scanId: scanID },
      },
      done: (value) => recordValue(jsonValue(value, "zap_api_call.status"), "zap_api_call.status").status === "100",
      deadline: Date.now() + 90_000,
    })

    const reportName = `zap-integration-${Date.now()}.json`
    const report = await client.callTool({
      name: "zap_generate_scoped_report",
      arguments: {
        file_path: reportName,
        template: "traditional-json",
        title: "Cyberful ZAP integration",
        sites: [`http://host.docker.internal:${target.port}`],
      },
    })
    expect("isError" in report && report.isError).not.toBe(true)
    expect(report.content).toContainEqual({
      type: "text",
      text: JSON.stringify({
        engagement_root_relative_path: reportName,
        container_path: `/zap/wrk/${reportName}`,
      }),
    })
    const reportFile = Bun.file(path.join(workarea, reportName))
    expect(await reportFile.exists()).toBe(true)
    const reportJson = await reportFile.json()
    const serialized = JSON.stringify(reportJson)
    expect(serialized).toContain(`host.docker.internal:${target.port}`)
    expect(serialized).not.toContain(excludedMarker)
    expect(resultText(report)).toContain(`http://host.docker.internal:${target.port}`)
    await releaseRuntimes(runtime)
  }, 240_000)

  test("captures Chrome HTTPS through the engagement CA SPKI without startup traffic", async () => {
    await verifyBrowserHttps("chrome")
  }, 180_000)

  test("captures Chromium HTTPS through the engagement CA SPKI without startup traffic", async () => {
    await verifyBrowserHttps("chromium")
  }, 180_000)

  test("removes the named bridge when its real phase gateway closes", async () => {
    upstreamDiagnostics = ""
    const runtime = await startEngagement({ sessionID: "integration-gateway-lifecycle", workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)
    const directory = await mkdtemp(path.join(workarea, "gateway-private-"))
    const materialized = SubsystemCli.materializePrivateMcpEnvironment(
      {
        cwd: workarea,
        permission: { kind: "readonly" },
        mcpServer: SubsystemGateway.gatewayMcpServer("ses_integration_gateway", {
          proxy: true,
          phase: "recon",
          env: {
            ...runtime.env,
            CYBERFUL_SUBSYSTEM_WORKFLOW: "pentest",
            CYBERFUL_OS_MCP_ENABLED: "0",
            CYBER_BROWSER_MCP_ENABLED: "0",
            CYBER_ZAP_ENABLED: "1",
          },
        }),
      },
      directory,
    )
    const configured = materialized.mcpServer
    if (!configured) throw new Error("gateway lifecycle fixture did not materialize an MCP server")
    const client = new Client({ name: "cyberful-gateway-lifecycle", version: "0" })
    const filters = ["label=org.cyberful.managed=zap-bridge", "label=org.cyberful.session=ses_integration_gateway"]
    let gatewayFailure: unknown
    try {
      const transport = pipeDiagnostics(
        new StdioClientTransport({
          command: configured.command,
          args: [...configured.args],
          stderr: "pipe",
          env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ...configured.env },
        }),
      )
      await client.connect(transport)
      expect((await client.listTools()).tools.some((tool) => tool.name === "zap_version")).toBe(true)
      await waitForDockerFilter(filters, true)
    } catch (error) {
      gatewayFailure = error
    }
    try {
      await client.close()
    } catch (error) {
      gatewayFailure = gatewayFailure
        ? new AggregateError([gatewayFailure, error], "gateway operation and cleanup both failed")
        : error
    }
    if (gatewayFailure) {
      const diagnostics = upstreamDiagnostics.trim() || "no gateway diagnostics were emitted"
      throw new Error(`phase gateway lifecycle failed:\n${diagnostics}`, { cause: gatewayFailure })
    }
    expect(await waitForDockerFilter(filters, false)).toBe("")
    await rm(directory, { recursive: true, force: true })
    await releaseRuntimes(runtime)
  }, 180_000)

  test("marks a failed ZAP startup degraded and keeps the direct browser warning visible", async () => {
    const previous = process.env.CYBER_ZAP_IMAGE
    process.env.CYBER_ZAP_IMAGE = `cyberful-zap-missing:${Date.now()}`
    const runtime = await startEngagement({ sessionID: "integration-fallback", workarea }).finally(() => {
      if (previous === undefined) delete process.env.CYBER_ZAP_IMAGE
      if (previous !== undefined) process.env.CYBER_ZAP_IMAGE = previous
    })
    expect(runtime.degraded).toBe(true)
    const warning = runtime.warning
    if (!warning) throw new Error("degraded ZAP runtime returned no browser warning")
    expect(warning).toContain("direct fallback")
    const browserClient = await connectBrowser({
      profile: "browser-fallback-profile",
      warning: runtime.env.CYBER_BROWSER_PROXY_WARNING,
    })
    const navigation = await browserClient.callTool({
      name: "browser_navigate",
      arguments: { url: `http://127.0.0.1:${target.port}/direct-fallback` },
    })
    expect("isError" in navigation && navigation.isError).not.toBe(true)
    const browserStatus = resultRecord(
      await browserClient.callTool({ name: "browser_status", arguments: {} }),
      "browser_status",
    )
    expect(recordValue(browserStatus.proxy, "browser_status.proxy")).toEqual({
      configured: false,
      mode: "direct",
      warning,
    })
    await releaseRuntimes(runtime)
  }, 60_000)
})
