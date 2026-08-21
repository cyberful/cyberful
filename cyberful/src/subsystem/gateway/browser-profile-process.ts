// ── Shared agent-browser Profile Process ───────────────────────────
// Owns one restartable agent-browser MCP transport and daemon session per
// Cyberful profile, plus complete paginated catalog discovery and web search.
// → cyberful/src/subsystem/gateway/server.ts — binds profile and ZAP policy.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────────

import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { rm } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { Process } from "@/util/process"
import { ManagedMcpUpstream, type ManagedMcpUpstreamStatus } from "./restartable-browser-upstream"

const LIST_TIMEOUT_MS = 20_000
const TOOL_TIMEOUT_MS = 600_000
const ZAP_PROBE_TIMEOUT_MS = 5_000
const CANCELLATION_SETTLE_MS = 2_250
const DAEMON_CLOSE_TIMEOUT_MS = 30_000
const DAEMON_RELEASE_TIMEOUT_MS = 5_000
const PROCESS_DIAGNOSTIC_BYTES = 8 * 1024

export interface BrowserProfileProcessOptions {
  readonly label: string
  readonly command: readonly [string, ...string[]]
  readonly environment: Readonly<Record<string, string>>
  readonly cleanupDirectory?: string
  readonly diagnosticSink?: (text: string) => void
  readonly ownProcess: (pid: number) => void
}

interface BrowserClientConnection {
  readonly client: Client
  readonly diagnostics: BrowserProcessDiagnostics
  readonly pid?: number
}

class BrowserProcessDiagnostics {
  #text = ""

  append(chunk: string) {
    this.#text += chunk
    while (Buffer.byteLength(this.#text, "utf8") > PROCESS_DIAGNOSTIC_BYTES)
      this.#text = this.#text.slice(Math.max(1, Math.floor(this.#text.length / 8)))
  }

  summary() {
    return this.#text.replace(/\s+/g, " ").trim()
  }
}

function browserProcessError(
  options: BrowserProfileProcessOptions,
  connection: Pick<BrowserClientConnection, "diagnostics" | "pid">,
  cause: unknown,
) {
  if (cause instanceof BrowserProfileProcessError) return cause
  const detail = cause instanceof Error ? cause.message : String(cause)
  const diagnostics = connection.diagnostics.summary()
  const command = options.command.map((part) => JSON.stringify(part)).join(" ")
  return new BrowserProfileProcessError(
    `${options.label} agent-browser MCP failed${connection.pid === undefined ? "" : ` (pid ${connection.pid})`}: ${detail}; command=${command}${diagnostics ? `; stderr=${diagnostics}` : "; stderr=<empty>"}`,
    { cause },
  )
}

export class BrowserProfileProcessError extends Error {
  readonly code = "BROWSER_MCP_PROCESS_FAILED"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BrowserProfileProcessError"
  }
}

class OwnedStdioClientTransport extends StdioClientTransport {
  #ownedPID?: number

  constructor(
    parameters: StdioServerParameters,
    private readonly ownProcess: (pid: number) => void,
  ) {
    super(parameters)
  }

  override async start() {
    await super.start()
    const pid = this.pid
    if (pid === null) throw new Error("agent-browser MCP transport started without a process id")
    this.#ownedPID = pid
    this.ownProcess(pid)
  }

  ownedPID() {
    return this.#ownedPID
  }
}

interface AgentBrowserDaemonPaths {
  readonly endpoint: string
  readonly pidFile: string
}

function agentBrowserDaemonPaths(
  environment: Readonly<Record<string, string>>,
): AgentBrowserDaemonPaths | undefined {
  const root = environment.AGENT_BROWSER_SOCKET_DIR?.trim()
  const session = environment.AGENT_BROWSER_SESSION?.trim()
  if (!root || !session) return
  const namespace = environment.AGENT_BROWSER_NAMESPACE?.trim()
  const directory = namespace ? path.join(root, "namespaces", namespace, "run") : root
  return {
    endpoint: path.join(directory, `${session}.${process.platform === "win32" ? "port" : "sock"}`),
    pidFile: path.join(directory, `${session}.pid`),
  }
}

function registerDaemonOwner(options: BrowserProfileProcessOptions): boolean {
  const paths = agentBrowserDaemonPaths(options.environment)
  if (!paths || !fs.existsSync(paths.pidFile)) return false
  try {
    const pid = Number(fs.readFileSync(paths.pidFile, "utf8").trim())
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
    options.ownProcess(pid)
    return true
  } catch {
    return false
  }
}

async function waitForDaemonRelease(environment: Readonly<Record<string, string>>): Promise<boolean> {
  const paths = agentBrowserDaemonPaths(environment)
  if (!paths) {
    await Bun.sleep(100)
    return false
  }
  const deadline = Date.now() + DAEMON_RELEASE_TIMEOUT_MS
  while (fs.existsSync(paths.endpoint) && Date.now() < deadline) await Bun.sleep(25)
  // The daemon removes its endpoint just before process exit. One quiet
  // interval prevents a replacement MCP from observing that dying daemon
  // as ready and then losing the socket on its first browser command.
  await Bun.sleep(100)
  return !fs.existsSync(paths.endpoint)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resultData(result: CallToolResult): Record<string, unknown> | undefined {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined
  const response = isRecord(structured?.response) ? structured.response : undefined
  return isRecord(response?.data) ? response.data : undefined
}

async function assertZapProxyReachable(environment: Readonly<Record<string, string>>): Promise<void> {
  const proxy = environment.AGENT_BROWSER_PROXY?.trim()
  if (!proxy) return
  const spki = environment.CYBER_BROWSER_PROXY_CA_SPKI?.trim()
  if (!spki) throw new Error("target browser requires the engagement-owned ZAP CA SPKI")
  const url = new URL(proxy)
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("target browser ZAP proxy must use http or https")
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port })
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error(`target browser ZAP proxy did not accept a connection within ${ZAP_PROBE_TIMEOUT_MS}ms`))
    }, ZAP_PROBE_TIMEOUT_MS)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.once("connect", () => finish())
    socket.once("error", (error) => finish(new Error(`target browser ZAP proxy is unreachable: ${error.message}`)))
  })
}

async function connectClient(options: BrowserProfileProcessOptions, onClose: () => void = () => undefined) {
  await assertZapProxyReachable(options.environment)
  const [command, ...args] = options.command
  const diagnostics = new BrowserProcessDiagnostics()
  const transport = new OwnedStdioClientTransport(
    {
      command,
      args,
      env: { ...options.environment },
      stderr: "pipe",
    },
    options.ownProcess,
  )
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    diagnostics.append(text)
    options.diagnosticSink?.(text)
  })
  const client = new Client({ name: "cyberful-browser-gateway", version: "0.1.0" })
  client.onclose = onClose
  try {
    await client.connect(transport)
    const ownedPID = transport.ownedPID()
    return {
      value: { client, diagnostics, ...(ownedPID === undefined ? {} : { pid: ownedPID }) },
      close: () => client.close(),
    }
  } catch (error) {
    const ownedPID = transport.ownedPID()
    await client.close().catch(() => undefined)
    await Bun.sleep(0)
    throw browserProcessError(options, { diagnostics, ...(ownedPID === undefined ? {} : { pid: ownedPID }) }, error)
  }
}

export async function listAllBrowserTools(client: Client): Promise<readonly Tool[]> {
  const tools: Tool[] = []
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    if (pages > 256) throw new Error("agent-browser tool pagination exceeded 256 pages")
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TIMEOUT_MS,
      maxTotalTimeout: LIST_TIMEOUT_MS,
    })
    if (!Array.isArray(page.tools)) throw new Error("agent-browser returned a malformed tool page")
    for (const tool of page.tools) {
      if (typeof tool.name !== "string" || tool.name.length === 0 || !isRecord(tool.inputSchema))
        throw new Error("agent-browser returned a malformed tool definition")
      if (names.has(tool.name)) throw new Error(`agent-browser returned duplicate tool '${tool.name}'`)
      names.add(tool.name)
      tools.push(tool)
      if (tools.length > 10_000) throw new Error("agent-browser tool catalog exceeded 10000 definitions")
    }
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error("agent-browser tool pagination returned a repeated cursor")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  if (!tools.some((tool) => tool.name === "agent_browser_tools_profiles"))
    throw new Error("agent-browser full catalog is missing agent_browser_tools_profiles")
  return tools
}

export async function browserToolCatalog(options: BrowserProfileProcessOptions): Promise<readonly Tool[]> {
  const connection = await connectClient(options)
  try {
    return await listAllBrowserTools(connection.value.client)
  } catch (error) {
    throw browserProcessError(options, connection.value, error)
  } finally {
    await connection.close()
  }
}

// ── One Catalog Defines Every Phase Browser Profile ─────────────
// agent-browser schemas are a property of the pinned binary and plugin set,
// not of a profile's cookies, proxy, or daemon identity. One phase owner keeps
// the first discovery promise, including a bounded failure, so startup never
// creates six short-lived MCP processes for the same immutable definitions.
// The direct search profile is supplied first by the gateway so catalog reads
// cannot be blocked by target ZAP readiness.
//
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────
export class PhaseBrowserToolCatalog {
  #catalog?: Promise<readonly Tool[]>

  load(options: BrowserProfileProcessOptions) {
    if (!this.#catalog) this.#catalog = browserToolCatalog(options)
    return this.#catalog
  }
}

async function callAgentBrowser(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
    signal,
    timeout: TOOL_TIMEOUT_MS,
    maxTotalTimeout: TOOL_TIMEOUT_MS,
  })
  return CallToolResultSchema.parse(result)
}

function activeTab(result: CallToolResult): string | undefined {
  const tabs = resultData(result)?.tabs
  if (!Array.isArray(tabs)) return
  const active = tabs.find((tab) => isRecord(tab) && tab.active === true)
  return isRecord(active) && typeof active.tabId === "string" ? active.tabId : undefined
}

function duckDuckGoUrl(query: string, safeSearch: string, attempt: number): string {
  if (query.length < 1 || query.length > 500) throw new Error("web_search query must contain 1-500 characters")
  const parameter = { strict: "1", moderate: "-1", off: "-2" }[safeSearch]
  if (parameter === undefined) throw new Error("web_search safe_search must be strict, moderate, or off")
  const url = new URL(attempt === 0 ? "https://html.duckduckgo.com/html/" : "https://lite.duckduckgo.com/lite/")
  url.searchParams.set("q", query)
  url.searchParams.set("kp", parameter)
  return url.toString()
}

const SEARCH_EXTRACTOR = String.raw`(() => {
  const compact = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const destination = (href) => {
    if (!href) return null;
    try {
      let url = new URL(href, location.href);
      if ((url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) && url.pathname === "/l/") {
        const wrapped = url.searchParams.get("uddg");
        if (wrapped) url = new URL(wrapped);
      }
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch { return null; }
  };
  const nodes = [...document.querySelectorAll(".result, article[data-testid='result'], .web-result")];
  const results = nodes.flatMap((node) => {
    const link = node.querySelector("a.result__a, a.result-link, h2 a, a[data-testid='result-title-a']");
    const url = destination(link?.getAttribute("href"));
    const title = compact(link?.textContent);
    if (!url || !title) return [];
    const badge = compact(node.querySelector(".badge--ad, .result__badge, [data-testid='ad-badge']")?.textContent).toLowerCase();
    return [{
      kind: String(node.className).toLowerCase().includes("result--ad") || badge === "ad" ? "sponsored" : "organic",
      title,
      url,
      display_url: compact(node.querySelector(".result__url, .result__extras__url, [data-testid='result-extras-url-link']")?.textContent) || new URL(url).host,
      snippet: compact(node.querySelector(".result__snippet, .result-snippet, [data-result='snippet'], [data-testid='result-snippet']")?.textContent),
    }];
  });
  const text = compact(document.body?.innerText);
  if (!results.length && /verify (?:you are|that you are) human|human verification|automated requests|unusual traffic|captcha/i.test(text)) throw new Error("DuckDuckGo presented a visible human challenge");
  if (!results.length && !/no results|no more results|did not match any documents/i.test(text)) throw new Error("DuckDuckGo result layout was not recognized");
  return results;
})()`

function toolFailure(result: CallToolResult): Error {
  const content = result.content.find((entry) => entry.type === "text")
  const detail = content?.type === "text" ? content.text.replace(/\s+/g, " ").trim() : "agent-browser call failed"
  return new Error(detail.slice(0, 512))
}

function searchError(error: unknown): CallToolResult {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 512)
  return {
    content: [
      { type: "text", text: `web_search failed after bounded internal attempts: ${detail || "unknown error"}` },
    ],
    structuredContent: { error: detail || "unknown error", retryable: false },
    isError: true,
  }
}

function searchResults(value: unknown, maxResults: number): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("web_search received an invalid extraction result")
  return value.slice(0, maxResults).map((item, index) => {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.url !== "string")
      throw new Error("web_search received a malformed result record")
    return { rank: index + 1, ...item }
  })
}

export async function webSearchWithAgentBrowser(
  client: Client,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  const maxResults = args.max_results === undefined ? 10 : Number(args.max_results)
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 20)
    throw new Error("web_search max_results must be an integer from 1 through 20")
  const safeSearch = typeof args.safe_search === "string" ? args.safe_search : "moderate"
  const timeoutMs = args.timeout_ms === undefined ? 30_000 : Number(args.timeout_ms)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("web_search timeout_ms must be an integer from 1 through 120000")

  const listed = await callAgentBrowser(client, "agent_browser_tab_list", { timeoutMs }, signal).catch(() => undefined)
  const previousTab = listed ? activeTab(listed) : undefined
  const label = `cyberful-search-${crypto.randomUUID()}`
  let temporaryTab: string | undefined
  try {
    const opened = await callAgentBrowser(
      client,
      "agent_browser_tab_new",
      { url: duckDuckGoUrl(query, safeSearch, 0), label, timeoutMs },
      signal,
    )
    if (opened.isError) throw toolFailure(opened)
    const openedData = resultData(opened)
    temporaryTab = typeof openedData?.tabId === "string" ? openedData.tabId : label
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0) {
          const navigated = await callAgentBrowser(
            client,
            "agent_browser_open",
            { url: duckDuckGoUrl(query, safeSearch, attempt), timeoutMs },
            signal,
          )
          if (navigated.isError) throw toolFailure(navigated)
        }
        const evaluated = await callAgentBrowser(
          client,
          "agent_browser_eval",
          { script: SEARCH_EXTRACTOR, timeoutMs },
          signal,
        )
        if (evaluated.isError) throw toolFailure(evaluated)
        const extracted = resultData(evaluated)?.result
        const results = searchResults(extracted, maxResults)
        const response = {
          engine: "duckduckgo",
          profile: "search",
          query,
          count: results.length,
          truncated: Array.isArray(extracted) && extracted.length > maxResults,
          results,
        }
        return {
          content: [{ type: "text", text: `${JSON.stringify(response, null, 2)}\n` }],
          structuredContent: response,
          isError: false,
        }
      } catch (error) {
        failure = error
      }
    }
    return searchError(failure)
  } catch (error) {
    return searchError(error)
  } finally {
    if (temporaryTab)
      await callAgentBrowser(client, "agent_browser_tab_close", { tab: temporaryTab, timeoutMs }, undefined).catch(
        () => undefined,
      )
    if (previousTab)
      await callAgentBrowser(client, "agent_browser_tab_switch", { tab: previousTab, timeoutMs }, undefined).catch(
        () => undefined,
      )
  }
}

export class AgentBrowserProfileProcess {
  private readonly upstream: ManagedMcpUpstream<BrowserClientConnection>
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: BrowserProfileProcessOptions) {
    this.upstream = new ManagedMcpUpstream<BrowserClientConnection>({
      label: options.label,
      cancellationGraceMs: CANCELLATION_SETTLE_MS,
      connect: (onClose) => connectClient(options, onClose),
      probe: async (connection, signal) => {
        try {
          await connection.client.listTools(undefined, {
            signal,
            timeout: LIST_TIMEOUT_MS,
            maxTotalTimeout: LIST_TIMEOUT_MS,
          })
        } catch (error) {
          throw browserProcessError(options, connection, error)
        }
      },
      probeTimeoutMs: ZAP_PROBE_TIMEOUT_MS,
    })
  }

  status(): ManagedMcpUpstreamStatus {
    return this.upstream.status()
  }

  health(signal?: AbortSignal): Promise<ManagedMcpUpstreamStatus> {
    return this.upstream.health(signal)
  }

  call<R>(_runID: string, operation: (client: Client) => Promise<R>, signal?: AbortSignal): Promise<R> {
    const queued = this.queue.then(async () => {
      signal?.throwIfAborted()
      try {
        const result = await this.upstream.call(async (connection) => {
          try {
            return await operation(connection.client)
          } catch (error) {
            throw browserProcessError(this.options, connection, error)
          }
        }, signal)
        registerDaemonOwner(this.options)
        return result
      } catch (error) {
        registerDaemonOwner(this.options)
        if (signal?.aborted) {
          await this.upstream.reset()
          await this.closeDaemon()
        }
        throw error
      }
    })
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  releaseOwner(_runID: string): Promise<void> {
    return Promise.resolve()
  }

  async closeProfile(): Promise<void> {
    await this.queue
    await this.upstream.reset()
    await this.closeDaemon()
  }

  async close(): Promise<void> {
    await this.queue
    await this.upstream.reset()
    await this.closeDaemon()
    await this.upstream.close()
    if (this.options.cleanupDirectory)
      await rm(this.options.cleanupDirectory, { recursive: true, force: true }).catch(() => undefined)
  }

  private async closeDaemon(): Promise<void> {
    const paths = agentBrowserDaemonPaths(this.options.environment)
    if (!paths || (!fs.existsSync(paths.endpoint) && !fs.existsSync(paths.pidFile))) return
    registerDaemonOwner(this.options)
    const [command, ...mcpArgs] = this.options.command
    const mcpIndex = mcpArgs.indexOf("mcp")
    const args = mcpIndex >= 0 ? [...mcpArgs.slice(0, mcpIndex), "close"] : ["close"]
    const result = await Process.run([command, ...args], {
      abort: AbortSignal.timeout(DAEMON_CLOSE_TIMEOUT_MS),
      env: { ...this.options.environment },
      maxOutputBytes: 64 * 1024,
      nothrow: true,
      timeout: 1_000,
    })
    const released = await waitForDaemonRelease(this.options.environment)
    if (released) return
    const detail = result.stderr.toString("utf8").replace(/\s+/g, " ").trim()
    throw new BrowserProfileProcessError(
      `${this.options.label} agent-browser daemon did not release its profile after close (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    )
  }
}

export function createBrowserProfileProcess(options: BrowserProfileProcessOptions): AgentBrowserProfileProcess {
  return new AgentBrowserProfileProcess(options)
}
