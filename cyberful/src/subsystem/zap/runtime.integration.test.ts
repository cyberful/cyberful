// ── Live ZAP Engagement Contract Tests ──────────────────────────
// Exercises real headless ZAP inside the unified engagement container, proxy
// capture, scoped MCP operations, authentication, and deterministic cleanup.
// → cyberful/src/subsystem/engagement-runtime.ts — owns the tested lifecycle.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { cyberGhidraBridgeCommand, cyberZapBridgeCommand } from "@/dependency/config"
import { run } from "@/util/process"
import { startEngagement as startUnifiedEngagement, type EngagementRuntime } from "../engagement-runtime"
import { SubsystemGateway } from "../gateway/config"
import { EngagementPolicyStore } from "../gateway/engagement-policy"

const runtimes: EngagementRuntime[] = []
const clients: Client[] = []
let workarea = ""
let target: ReturnType<typeof Bun.serve>
let httpsTarget: ReturnType<typeof Bun.serve>
let gitRepository = ""
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
  const [command, ...args] = cyberZapBridgeCommand(requiredZapContainer(runtime))
  if (!command) throw new Error("unified ZAP bridge command is unavailable")
  const transport = new StdioClientTransport({
    command,
    args,
    stderr,
    env: {
      PATH: process.env.PATH ?? "",
      CYBER_ZAP_MCP_KEY: mcpKey,
      CYBER_ZAP_API_KEY: runtime.env.CYBER_ZAP_API_KEY,
    },
  })
  return stderr === "pipe" ? pipeDiagnostics(transport) : transport
}

function requiredZapContainer(runtime: EngagementRuntime) {
  if (!runtime.zapContainer) throw new Error("engagement did not start its dedicated ZAP container")
  return runtime.zapContainer
}

function zapHostPaths(root: string, sessionID: string) {
  const scope = createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
  return {
    attestation: path.join(root, "raw/zap/trust", scope, "attestation.json"),
    bundle: path.join(root, "raw/zap/trust", scope, "ca-bundle.pem"),
    privateCertificate: path.join(root, "raw/zap/runtime", scope, "root-ca.pem"),
    publicCertificate: path.join(root, "raw/zap/trust", scope, "root-ca-public.pem"),
  }
}

async function startEngagement(input: { sessionID: string; workarea: string }) {
  return startUnifiedEngagement({
    ...input,
    workflow: "pentest",
    container: `cyberful-runtime-${input.sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`,
  })
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
  const text = resultText(result)
  if ("isError" in result && result.isError) throw new Error(`${label} failed: ${text}`)
  return recordValue(jsonValue(text, label), label)
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

function historyUrl(value: unknown, label: string) {
  return stringValue(recordValue(value, label).url, `${label}.url`)
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
  const initialMessages = optionalArray(
    resultRecord(
      await zapClient.callTool({ name: "zap_history_search", arguments: { start: 0, count: 100 } }),
      "zap_history_search",
    ).messages,
    "zap_history_search.messages",
  )
  expect(initialMessages.map((message, index) => historyUrl(message, `initialMessages[${index}]`))).toEqual(
    initialMessages.map(() => "http://127.0.0.1:8282/"),
  )
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
  expect(startupMessages.map((message, index) => historyUrl(message, `startupMessages[${index}]`))).toEqual(
    startupMessages.map(() => "http://127.0.0.1:8282/"),
  )
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

function coreProxyEnvironment(runtime: EngagementRuntime) {
  const proxy = new URL(runtime.env.CYBER_ZAP_PROXY_URL)
  proxy.hostname = "host.docker.internal"
  const proxyUrl = proxy.toString()
  const bundle = runtime.env.CYBERFUL_OS_CA_BUNDLE
  if (!bundle) throw new Error("engagement did not expose its attested core CA bundle")
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    SSL_CERT_FILE: bundle,
    CURL_CA_BUNDLE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    GIT_SSL_CAINFO: bundle,
    GIT_SSL_NO_VERIFY: "false",
    PIP_CERT: bundle,
    NODE_EXTRA_CA_CERTS: bundle,
    NODE_USE_ENV_PROXY: "1",
    BUNDLE_SSL_CA_CERT: bundle,
    BUNDLE_SSL_VERIFY_MODE: "1",
  }
}

async function coreClientOutput(
  runtime: EngagementRuntime,
  command: readonly string[],
  overrides: Record<string, string> = {},
) {
  const environment = { ...coreProxyEnvironment(runtime), ...overrides }
  return dockerOutput(
    "exec",
    ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    runtime.container,
    ...command,
  )
}

async function terminateManagedService(runtime: EngagementRuntime, serviceName: string) {
  const container = serviceName === "zap" ? requiredZapContainer(runtime) : runtime.container
  const status = recordValue(
    JSON.parse(await dockerOutput("exec", container, "cat", "/run/cyberful/status.json")),
    "runtime status",
  )
  const services = recordValue(status.services, "runtime status.services")
  const service = recordValue(services[serviceName], `runtime status.services.${serviceName}`)
  if (typeof service.pid !== "number" || !Number.isSafeInteger(service.pid) || service.pid <= 0) {
    throw new Error(`runtime status.services.${serviceName}.pid must be a positive integer`)
  }
  await dockerOutput("exec", container, "kill", "-TERM", "--", `-${service.pid}`)
}

beforeAll(async () => {
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    captureDiagnostic(String(chunk))
    return true
  })
  restoreStderr = () => stderrWrite.mockRestore()
  workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-integration-")))
  const gitSource = path.join(workarea, "git-source")
  gitRepository = path.join(workarea, "repo.git")
  await mkdir(gitSource, { mode: 0o700 })
  await run(["git", "init", gitSource], {
    abort: AbortSignal.timeout(30_000),
    timeout: 1_000,
    maxOutputBytes: 64 * 1024,
  })
  await writeFile(path.join(gitSource, "README.md"), "# Cyberful TLS integration fixture\n")
  await run(["git", "-C", gitSource, "add", "README.md"], {
    abort: AbortSignal.timeout(30_000),
    timeout: 1_000,
    maxOutputBytes: 64 * 1024,
  })
  await run(
    [
      "git",
      "-C",
      gitSource,
      "-c",
      "user.name=Cyberful Test",
      "-c",
      "user.email=cyberful-test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { abort: AbortSignal.timeout(30_000), timeout: 1_000, maxOutputBytes: 64 * 1024 },
  )
  await run(["git", "clone", "--bare", gitSource, gitRepository], {
    abort: AbortSignal.timeout(30_000),
    timeout: 1_000,
    maxOutputBytes: 64 * 1024,
  })
  await run(["git", "-C", gitRepository, "update-server-info"], {
    abort: AbortSignal.timeout(30_000),
    timeout: 1_000,
    maxOutputBytes: 64 * 1024,
  })
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
    fetch: async (request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const repositoryPrefix = "/repo.git/"
      if (pathname.startsWith(repositoryPrefix)) {
        const candidate = path.resolve(gitRepository, pathname.slice(repositoryPrefix.length))
        if (candidate.startsWith(`${gitRepository}${path.sep}`)) {
          const file = Bun.file(candidate)
          if (await file.exists()) return new Response(file)
        }
        return new Response("not found", { status: 404 })
      }
      return new Response(`secure integration target ${pathname}`)
    },
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
  test("installs the persisted aggregate rate limit through the local ZAP API authority", async () => {
    const policyWorkarea = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-policy-integration-")),
    )
    let runtime: EngagementRuntime | undefined
    try {
      const store = new EngagementPolicyStore(policyWorkarea)
      await store.commit(
        store.prepare({
          action: "set",
          profiles: [],
          authorized_http_hosts: ["app.example.test", "*.api.example.test"],
          global_http_rps: 4,
        }),
      )
      runtime = await startEngagement({ sessionID: "integration-rate-limit", workarea: policyWorkarea })
      expect(runtime.degraded).toBe(false)
      const endpoint = new URL("/JSON/network/view/getRateLimitRules/", runtime.env.CYBER_ZAP_PROXY_URL)
      endpoint.searchParams.set("apikey", runtime.env.CYBER_ZAP_API_KEY)
      const response = await fetch(endpoint, { headers: { Host: "zap" } })
      expect(response.ok).toBe(true)
      const body = await response.text()
      expect(body).toContain("Cyberful engagement global HTTP budget")
      expect(body).toContain("4")

      await terminateManagedService(runtime, "zap")
      await Bun.sleep(1_500)
      const prepared = await runtime.preparePhase({ phase: "recon", attempt: 1 })
      expect(prepared.warnings.join(" ")).toContain("session preserved")
      const recovered = await fetch(endpoint, { headers: { Host: "zap" } })
      expect(recovered.ok).toBe(true)
      expect(await recovered.text()).toContain("Cyberful engagement global HTTP budget")
    } finally {
      await runtime?.stop()
      await rm(policyWorkarea, { recursive: true, force: true })
    }
  }, 180_000)

  test("authenticate API/MCP and expose the complete hybrid surface on loopback only", async () => {
    const runtime = await startEngagement({ sessionID: "integration-surface", workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)

    const published = await dockerOutput("port", requiredZapContainer(runtime), "8080/tcp")
    expect(published).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(
      await dockerOutput("inspect", "--format", "{{json .NetworkSettings.Ports}}", requiredZapContainer(runtime)),
    ).not.toContain("8282")
    const xvfbProcesses = (await dockerOutput("exec", requiredZapContainer(runtime), "pgrep", "-x", "Xvfb")).split("\n")
    expect(xvfbProcesses.length).toBeGreaterThan(0)
    expect(xvfbProcesses.every((pid) => /^\d+$/.test(pid))).toBe(true)
    await dockerOutput(
      "exec",
      "--env",
      "HOME=/tmp",
      runtime.container,
      "timeout",
      "30",
      "firefox-esr",
      "--headless",
      "--screenshot",
      "/tmp/cyberful-firefox-headless.png",
      "about:blank",
    )
    await dockerOutput("exec", runtime.container, "test", "-s", "/tmp/cyberful-firefox-headless.png")

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
    const definitions = (await client.listTools()).tools
    const tools = definitions.map((item) => item.name)
    expect(tools).toContain("zap_version")
    for (const name of [
      "zap_api_catalog",
      "zap_api_call",
      "zap_http_request",
      "zap_generate_workarea_report",
      "zap_history_search",
      "zap_history_get",
      "zap_websocket_history",
      "zap_context_auth",
      "zap_oast",
      "zap_prompt_get",
    ])
      expect(tools).toContain(name)

    const oastDefinition = definitions.find((item) => item.name === "zap_oast")
    expect(recordValue(oastDefinition?.inputSchema, "zap_oast schema")).toMatchObject({
      properties: { component: { const: "oast" } },
    })
    const oastCapabilities = resultRecord(
      await client.callTool({ name: "zap_oast", arguments: {} }),
      "zap_oast capabilities",
    )
    expect(oastCapabilities).toMatchObject({
      status: "available",
      component: "oast",
      lifecycle: {
        registration: "not_exposed_by_http_api",
        payload_generation: "not_exposed_by_http_api",
        polling: "not_exposed_by_http_api",
        interaction_history: "not_exposed_by_http_api",
      },
    })
    expect(arrayValue(oastCapabilities.operations, "zap_oast operations")).toContainEqual({
      component: "oast",
      type: "view",
      operation: "getServices",
    })
    const oastServices = resultRecord(
      await client.callTool({
        name: "zap_oast",
        arguments: { component: "oast", type: "view", operation: "getServices" },
      }),
      "zap_oast getServices",
    )
    expect(oastServices).toMatchObject({
      status: "completed",
      result_state: "data",
      operation: { component: "oast", type: "view", operation: "getServices" },
    })
    const guessedLifecycle = await client.callTool({
      name: "zap_oast",
      arguments: { component: "interactsh", type: "view", operation: "getNewPayload" },
    })
    expect("isError" in guessedLifecycle && guessedLifecycle.isError).toBe(true)
    expect(resultText(guessedLifecycle)).toContain("not exposed by the installed HTTP API")

    expect((await client.listResources()).resources.length).toBeGreaterThan(0)
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    expect((await client.listPrompts()).prompts.map((item) => item.name)).toEqual(
      expect.arrayContaining(["zap_baseline_scan", "zap_full_scan"]),
    )
    const catalog = resultArray(await client.callTool({ name: "zap_api_catalog", arguments: {} }), "zap_api_catalog")
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog).toContainEqual({ component: "core", type: "action", operation: "shutdown" })
    expect(catalog).toContainEqual({ component: "core", type: "action", operation: "sendRequest" })
    expect(catalog).toContainEqual({ component: "core", type: "view", operation: "messages" })
    const unrestricted = await client.callTool({
      name: "zap_api_call",
      arguments: { component: "core", type: "view", operation: "messages", parameters: { start: 0, count: 1 } },
    })
    expect("isError" in unrestricted && unrestricted.isError).toBe(false)
    await releaseRuntimes(runtime)
  }, 180_000)

  test("isolates the proxy key and verifies standard core clients through the public CA bundle", async () => {
    const sessionID = "integration-core-proxy-trust"
    const runtime = await startEngagement({ sessionID, workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)
    expect(runtime.env.CYBERFUL_OS_CA_BUNDLE).toBe("/run/cyberful/proxy-trust/ca-bundle.pem")

    await dockerOutput("exec", requiredZapContainer(runtime), "test", "-s", "/var/lib/cyberful/zap/root-ca.pem")
    await dockerOutput(
      "exec",
      requiredZapContainer(runtime),
      "grep",
      "-q",
      "PRIVATE KEY",
      "/var/lib/cyberful/zap/root-ca.pem",
    )
    await dockerOutput("exec", runtime.container, "test", "!", "-e", "/workspace/raw/zap/runtime/root-ca.pem")
    await dockerOutput("exec", runtime.container, "test", "-r", "/workspace/raw/zap/trust/ca-bundle.pem")
    await dockerOutput("exec", runtime.container, "test", "-r", runtime.env.CYBERFUL_OS_CA_BUNDLE)
    const publicCertificate = await dockerOutput(
      "exec",
      runtime.container,
      "cat",
      "/run/cyberful/proxy-trust/root-ca-public.pem",
    )
    expect(publicCertificate).toContain("BEGIN CERTIFICATE")
    expect(publicCertificate).not.toContain("PRIVATE KEY")
    const persistedAttestation = await Bun.file(zapHostPaths(workarea, sessionID).attestation).text()
    expect(persistedAttestation).toContain('"version":1')
    expect(persistedAttestation).not.toContain("CERTIFICATE")
    expect(persistedAttestation).not.toContain("PRIVATE KEY")
    const systemCertificateCount = Number(
      await dockerOutput("exec", runtime.container, "grep", "-c", "BEGIN CERTIFICATE", "/etc/ssl/certs/ca-certificates.crt"),
    )
    const combinedCertificateCount = Number(
      await dockerOutput("exec", runtime.container, "grep", "-c", "BEGIN CERTIFICATE", runtime.env.CYBERFUL_OS_CA_BUNDLE),
    )
    expect(combinedCertificateCount).toBeGreaterThan(systemCertificateCount)

    const httpsUrl = `https://host.docker.internal:${httpsTarget.port}/verified-clients`
    expect(await coreClientOutput(runtime, ["curl", "-fsS", httpsUrl])).toContain("verified-clients")
    expect(
      await coreClientOutput(runtime, [
        "/opt/cyberful-os-venv/bin/python",
        "-c",
        "import requests,sys; response=requests.get(sys.argv[1], timeout=15); response.raise_for_status(); print(response.text)",
        httpsUrl,
      ]),
    ).toContain("verified-clients")
    expect(
      await coreClientOutput(runtime, [
        "node",
        "--use-env-proxy",
        "--eval",
        "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text() }).then(console.log)",
        httpsUrl,
      ]),
    ).toContain("verified-clients")

    const gitUrl = `https://host.docker.internal:${httpsTarget.port}/repo.git`
    expect(await coreClientOutput(runtime, ["git", "ls-remote", gitUrl])).toContain("HEAD")
    const clonePath = `/tmp/cyberful-proxy-trust-${process.pid}`
    await coreClientOutput(runtime, ["git", "clone", gitUrl, clonePath])
    await coreClientOutput(runtime, ["git", "-C", clonePath, "fetch", "--force"])

    await expect(
      coreClientOutput(runtime, ["curl", "-fsS", httpsUrl], {
        CURL_CA_BUNDLE: "/workspace/target.pem",
      }),
    ).rejects.toThrow()
    const bundlePath = zapHostPaths(workarea, sessionID).bundle
    await writeFile(bundlePath, "corrupt bundle\n", { mode: 0o600 })
    await runtime.preparePhase({ phase: "recon", attempt: 1 })
    expect(await Bun.file(bundlePath).text()).toContain("BEGIN CERTIFICATE")
    const lifecycle = await Bun.file(path.join(workarea, "raw/operations/zap-runtime.jsonl")).text()
    expect(lifecycle).toContain('"ca_bundle_attested":true')
    expect(lifecycle).not.toContain("PRIVATE KEY")
    await releaseRuntimes(runtime)
  }, 240_000)

  test("fails closed when a corrupt bundle cannot be regenerated and verified", async () => {
    const isolatedWorkarea = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-corrupt-trust-integration-")),
    )
    let runtime: EngagementRuntime | undefined
    try {
      const sessionID = "integration-corrupt-proxy-trust"
      runtime = await startEngagement({ sessionID, workarea: isolatedWorkarea })
      runtimes.push(runtime)
      await writeFile(zapHostPaths(isolatedWorkarea, sessionID).bundle, "corrupt bundle\n", {
        mode: 0o600,
      })
      await dockerOutput(
        "exec",
        runtime.container,
        "mv",
        "/etc/ssl/certs/ca-certificates.crt",
        "/tmp/ca-certificates.crt.disabled",
      )
      await expect(runtime.preparePhase({ phase: "exploit", attempt: 1 })).rejects.toThrow(
        "required OWASP ZAP upstream is unavailable",
      )
      const lifecycle = await Bun.file(path.join(isolatedWorkarea, "raw/operations/zap-runtime.jsonl")).text()
      expect(lifecycle).toContain('"failure_stage":"ca"')
    } finally {
      await runtime?.stop()
      if (runtime) {
        const index = runtimes.indexOf(runtime)
        if (index >= 0) runtimes.splice(index, 1)
      }
      await rm(isolatedWorkarea, { recursive: true, force: true })
    }
  }, 240_000)

  test("authorizes CA rotation only after reset recovery installs the replacement bundle", async () => {
    const isolatedWorkarea = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-ca-reset-integration-")),
    )
    let runtime: EngagementRuntime | undefined
    try {
      const sessionID = "integration-proxy-ca-reset"
      runtime = await startEngagement({ sessionID, workarea: isolatedWorkarea })
      runtimes.push(runtime)
      const { publicCertificate: publicPath, privateCertificate: privatePath } = zapHostPaths(isolatedWorkarea, sessionID)
      const originalCertificate = await Bun.file(publicPath).text()
      await terminateManagedService(runtime, "zap")
      await rm(privatePath)
      const prepared = await runtime.preparePhase({ phase: "hacker", attempt: 1 })
      expect(prepared.warnings.join(" ")).toContain("new visible session generation")
      expect(await Bun.file(publicPath).text()).not.toBe(originalCertificate)
      await dockerOutput(
        "exec",
        runtime.container,
        "openssl",
        "verify",
        "-CAfile",
        runtime.env.CYBERFUL_OS_CA_BUNDLE,
        "/run/cyberful/proxy-trust/root-ca-public.pem",
      )
      const lifecycle = await Bun.file(path.join(isolatedWorkarea, "raw/operations/zap-runtime.jsonl")).text()
      expect(lifecycle).toContain('"event":"ca_rotation_authorized"')
      expect(lifecycle).toContain('"ca_certificate_changed":true')
    } finally {
      await runtime?.stop()
      if (runtime) {
        const index = runtimes.indexOf(runtime)
        if (index >= 0) runtimes.splice(index, 1)
      }
      await rm(isolatedWorkarea, { recursive: true, force: true })
    }
  }, 240_000)

  test("persists CA continuity across a host runtime restart and rotates only through reset recovery", async () => {
    const isolatedWorkarea = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-ca-durable-integration-")),
    )
    const sessionID = "integration-proxy-ca-durable"
    let runtime: EngagementRuntime | undefined
    try {
      runtime = await startEngagement({ sessionID, workarea: isolatedWorkarea })
      runtimes.push(runtime)
      const paths = zapHostPaths(isolatedWorkarea, sessionID)
      const originalCertificate = await Bun.file(paths.publicCertificate).text()
      const originalAttestation = await Bun.file(paths.attestation).text()
      await runtime.stop()
      runtimes.splice(runtimes.indexOf(runtime), 1)
      runtime = undefined

      await rm(paths.privateCertificate)
      runtime = await startEngagement({ sessionID, workarea: isolatedWorkarea })
      runtimes.push(runtime)
      expect(runtime.degraded).toBe(true)
      expect(runtime.env.CYBER_ZAP_READY).toBeUndefined()
      expect(await Bun.file(paths.publicCertificate).text()).toBe(originalCertificate)
      expect(await Bun.file(paths.attestation).text()).toBe(originalAttestation)

      const prepared = await runtime.preparePhase({ phase: "recon", attempt: 1 })
      expect(prepared.warnings.join(" ")).toContain("new visible session generation")
      expect(await Bun.file(paths.publicCertificate).text()).not.toBe(originalCertificate)
      expect(await Bun.file(paths.attestation).text()).not.toBe(originalAttestation)
      const lifecycle = await Bun.file(path.join(isolatedWorkarea, "raw/operations/zap-runtime.jsonl")).text()
      expect(lifecycle).toContain('"event":"startup_failed"')
      expect(lifecycle).toContain('"failure_stage":"ca"')
      expect(lifecycle).toContain('"recovery_mode":"preserve"')
      expect(lifecycle).toContain('"event":"ca_rotation_authorized"')
    } finally {
      await runtime?.stop()
      if (runtime) {
        const index = runtimes.indexOf(runtime)
        if (index >= 0) runtimes.splice(index, 1)
      }
      await rm(isolatedWorkarea, { recursive: true, force: true })
    }
  }, 300_000)

  test("concurrent bridges share one history while separate engagements remain isolated", async () => {
    const active: EngagementRuntime[] = []
    let firstContainer = ""
    try {
      const started = await Promise.allSettled([
        startEngagement({ sessionID: "integration-shared", workarea }),
        startEngagement({ sessionID: "integration-isolated", workarea }),
      ])
      for (const result of started) if (result.status === "fulfilled") active.push(result.value)
      runtimes.push(...active)
      const failures = started.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length > 0) throw new AggregateError(failures, "one or more concurrent engagements failed to start")
      const [first, second] = active
      if (!first || !second) throw new Error("concurrent engagement startup returned an incomplete pair")
      firstContainer = first.container
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
    } finally {
      await releaseRuntimes(...active)
    }
    const inspect = await run(["docker", "inspect", firstContainer], {
      abort: AbortSignal.timeout(30_000),
      timeout: 1_000,
      maxOutputBytes: 64 * 1024,
      nothrow: true,
    })
    expect(inspect.code).not.toBe(0)
  }, 240_000)

  test("connects dedicated ZAP and core Ghidra bridges concurrently", async () => {
    const combinedRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cyberful-combined-runtime-integration-")),
    )
    const combinedWorkarea = path.join(combinedRoot, "workarea")
    const ghidraStore = path.join(combinedRoot, "ghidra-store")
    await Promise.all([mkdir(combinedWorkarea, { mode: 0o700 }), mkdir(ghidraStore, { mode: 0o700 })])
    let runtime: EngagementRuntime | undefined
    const combinedClients: Client[] = []
    try {
      runtime = await startUnifiedEngagement({
        sessionID: "integration-combined-bridges",
        workflow: "pentest",
        container: `cyberful-runtime-integration-combined-${process.pid}`,
        workarea: combinedWorkarea,
        ghidraStore,
      })
      runtimes.push(runtime)
      expect(runtime.degraded).toBe(false)

      const zap = new Client({ name: "cyberful-zap-combined", version: "0" })
      const [ghidraCommand, ...ghidraArgs] = cyberGhidraBridgeCommand(runtime.container)
      if (!ghidraCommand) throw new Error("unified Ghidra bridge command is unavailable")
      const ghidra = new Client({ name: "cyberful-ghidra-combined", version: "0" })
      await Promise.all([
        zap.connect(bridge(runtime)),
        ghidra.connect(
          pipeDiagnostics(
            new StdioClientTransport({
              command: ghidraCommand,
              args: ghidraArgs,
              stderr: "pipe",
              env: {
                PATH: process.env.PATH ?? "",
                CYBER_GHIDRA_MCP_KEY: runtime.env.CYBER_GHIDRA_MCP_KEY,
              },
            }),
          ),
        ),
      ])
      combinedClients.push(zap, ghidra)
      const [zapTools, ghidraTools] = await Promise.all([zap.listTools(), ghidra.listTools()])
      expect(zapTools.tools.some((tool) => tool.name === "zap_version")).toBe(true)
      expect(ghidraTools.tools.some((tool) => tool.name === "ghidra_decompile")).toBe(true)

      expect(
        await dockerOutput(
          "inspect",
          "--format",
          '{{index .Config.Labels "org.cyberful.managed"}} {{index .Config.Labels "org.cyberful.runtime"}}',
          runtime.container,
        ),
      ).toBe("engagement cyberful-os")
      const capEff = BigInt(
        `0x${await dockerOutput("exec", runtime.container, "sh", "-lc", "awk '/CapEff/ {print $2}' /proc/self/status")}`,
      )
      expect(capEff & (1n << 12n)).not.toBe(0n)
      expect(capEff & (1n << 19n)).not.toBe(0n)
      await dockerOutput("exec", runtime.container, "touch", "/workspace/.cyberful-runtime-write-test")
      expect((await stat(path.join(combinedWorkarea, ".cyberful-runtime-write-test"))).isFile()).toBe(true)
      const expectedIdentity = `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`
      expect(await dockerOutput("exec", runtime.container, "stat", "-c", "%u:%g", "/ghidra/store/home")).toBe(
        expectedIdentity,
      )
      expect(await dockerOutput("exec", requiredZapContainer(runtime), "stat", "-c", "%u:%g", "/var/lib/cyberful/zap")).toBe(
        expectedIdentity,
      )
      expect(
        await dockerOutput("ps", "--all", "--quiet", "--filter", "label=org.cyberful.managed=zap-bridge"),
      ).toBe("")
    } finally {
      await cleanupOperations("combined bridge cleanup failed", [
        ...combinedClients.map((client) => () => client.close()),
        ...(runtime ? [runtime.stop] : []),
        () => rm(combinedRoot, { recursive: true, force: true }),
      ])
      if (runtime) {
        const index = runtimes.indexOf(runtime)
        if (index >= 0) runtimes.splice(index, 1)
      }
    }
  }, 420_000)

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
      name: "zap_generate_workarea_report",
      arguments: {
        file_path: reportName,
        template: "traditional-json",
        title: "Cyberful ZAP integration",
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
    expect(serialized).toContain(excludedMarker)
    await releaseRuntimes(runtime)
  }, 240_000)

  test.skipIf(
    ![
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chrome",
    ].some((candidate) => fs.existsSync(candidate)),
  )("captures system Chrome HTTPS through the engagement CA SPKI without external startup traffic", async () => {
    await verifyBrowserHttps("chrome")
  }, 180_000)

  test("captures Chromium HTTPS through the engagement CA SPKI without external startup traffic", async () => {
    await verifyBrowserHttps("chromium")
  }, 180_000)

  test("uses docker exec without creating a bridge container", async () => {
    upstreamDiagnostics = ""
    const runtime = await startEngagement({ sessionID: "integration-gateway-lifecycle", workarea })
    runtimes.push(runtime)
    expect(runtime.degraded).toBe(false)
    const configured = SubsystemGateway.gatewayMcpServer("ses_integration_gateway", {
      proxy: true,
      phase: "recon",
      env: {
        ...runtime.env,
        CYBERFUL_SUBSYSTEM_WORKFLOW: "pentest",
        CYBERFUL_OS_MCP_ENABLED: "0",
        CYBER_BROWSER_MCP_ENABLED: "0",
        CYBER_ZAP_ENABLED: "1",
      },
    })
    const client = new Client({ name: "cyberful-gateway-lifecycle", version: "0" })
    let gatewayFailure: unknown
    try {
      const transport = pipeDiagnostics(
        new StdioClientTransport({
          command: configured.command,
          args: [...configured.args],
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: os.homedir(),
            ...configured.env,
            ...configured.privateEnv,
          },
        }),
      )
      await client.connect(transport)
      expect((await client.listTools()).tools.some((tool) => tool.name === "zap_version")).toBe(true)
      expect(await dockerOutput("ps", "--all", "--quiet", "--filter", "label=org.cyberful.managed=zap-bridge")).toBe("")
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
    expect(await dockerOutput("ps", "--all", "--quiet", "--filter", "label=org.cyberful.managed=zap-bridge")).toBe("")
    await releaseRuntimes(runtime)
  }, 180_000)

  test("does not restart ZAP autonomously and recovers it at the next phase preflight", async () => {
    upstreamDiagnostics = ""
    const sessionID = "integration-zap-death"
    const runtime = await startEngagement({ sessionID, workarea })
    runtimes.push(runtime)
    const { publicCertificate: publicCertificatePath, bundle: bundlePath } = zapHostPaths(workarea, sessionID)
    const [publicCertificateBefore, bundleBefore] = await Promise.all([
      Bun.file(publicCertificatePath).text(),
      Bun.file(bundlePath).arrayBuffer(),
    ])
    await terminateManagedService(runtime, "zap")
    await Bun.sleep(1_500)
    expect(await dockerOutput("inspect", "--format", "{{.State.Running}}", requiredZapContainer(runtime))).toBe("true")
    const status = JSON.parse(await dockerOutput("exec", requiredZapContainer(runtime), "cat", "/run/cyberful/status.json"))
    expect(status.status).toBe("degraded")
    expect(status.services.zap.status).toBe("exited")
    await Bun.sleep(1_500)
    const laterStatus = JSON.parse(await dockerOutput("exec", requiredZapContainer(runtime), "cat", "/run/cyberful/status.json"))
    expect(laterStatus.services.zap.pid).toBe(status.services.zap.pid)
    const deadBridge = new Client({ name: "cyberful-zap-dead-service", version: "0" })
    await expect(deadBridge.connect(bridge(runtime))).rejects.toBeDefined()
    await deadBridge.close().catch(() => undefined)
    expect(upstreamDiagnostics).toMatch(/(?:refused|closed|connect|unavailable|exited)/i)
    const recovered = await runtime.preparePhase({ phase: "hacker", attempt: 1 })
    expect(recovered.warnings.join(" ")).toContain("session preserved")
    const recoveredStatus = JSON.parse(
      await dockerOutput("exec", requiredZapContainer(runtime), "cat", "/run/cyberful/status.json"),
    )
    expect(recoveredStatus.services.zap.status).toBe("ready")
    expect(recoveredStatus.services.zap.restart_count).toBe(1)
    expect(await Bun.file(publicCertificatePath).text()).toBe(publicCertificateBefore)
    expect(Buffer.from(await Bun.file(bundlePath).arrayBuffer())).toEqual(Buffer.from(bundleBefore))
    const recoveredBridge = await connect(runtime)
    expect((await recoveredBridge.listTools()).tools.some((tool) => tool.name === "zap_version")).toBe(true)
    await releaseRuntimes(runtime)
  }, 180_000)
})
