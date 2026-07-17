#!/usr/bin/env bun
// ── Engagement-Scoped ZAP MCP Bridge ────────────────────────────────
// Speaks stdio MCP to Cyberful, forwards the official ZAP MCP surface, and
// adds bounded wrappers over the catalog discovered from this ZAP instance.
// Only this bridge reaches ZAP's loopback API; generic calls cannot bypass the
// operation policy, workarea paths, response limits, or metadata-first history.
// → mcps/zap/zap_policy.mjs — blocks host-owned and unsafe API operations.
// ────────────────────────────────────────────────────────────────────

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  apiParameters,
  assertAllowedOperation,
  assertScopedZapTool,
  assertZapUrlAllowed,
  isAllowedOperation,
  operationKey,
  parseZapAllowedOrigins,
} from "./zap_policy.mjs"
import { normalizedHttpRequest, recordedRequestTarget } from "./zap_http_request.mjs"
import { engagementReportPath, engagementReportSites, withEngagementReportPath } from "./zap_report_path.mjs"
import { messageMetadata, projectHistory, storeContentAddressed } from "./zap_history.mjs"

const MCP_URL = process.env.CYBER_ZAP_MCP_URL || "http://127.0.0.1:8282"
const API_URL = (process.env.CYBER_ZAP_API_URL || "http://127.0.0.1:8080").replace(/\/+$/, "")
const MCP_KEY = required("CYBER_ZAP_MCP_KEY")
const API_KEY = required("CYBER_ZAP_API_KEY")
const WORKAREA = process.env.CYBER_ZAP_WORKAREA || "/zap/wrk"
const MAX_INLINE_BYTES = boundedPositiveInt(
  process.env.CYBER_ZAP_MAX_INLINE_BYTES,
  750_000,
  5_000_000,
  "CYBER_ZAP_MAX_INLINE_BYTES",
)
const MAX_RESPONSE_BYTES = 25_000_000
const MAX_CATALOG_BYTES = 5_000_000
const API_TIMEOUT_MS = 15_000
const ALLOWED_ORIGINS = parseZapAllowedOrigins(process.env.CYBER_ZAP_ALLOWED_ORIGINS)

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function boundedPositiveInt(value, fallback, maximum, name) {
  if (value === undefined || value === "") return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`)
  }
  return parsed
}

function text(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

// ── ZAP API Reads Have Fixed Time And Memory Budgets ───────────────
// Every loopback API request has a deadline, and response bodies are consumed as
// bounded streams rather than unbounded array buffers. Error snippets stop after
// a small diagnostic prefix. Catalog pages use a tighter limit, while larger
// successful tool results are stored only after their global ceiling is proven.
// This keeps a stalled or malformed ZAP add-on from exhausting the bridge.
// ────────────────────────────────────────────────────────────────────

async function zapFetch(url, init, label) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  } catch (error) {
    const suffix = error instanceof Error && /Timeout|Abort/i.test(error.name) ? ` after ${API_TIMEOUT_MS}ms` : ""
    throw new Error(`${label} request failed${suffix}`, { cause: error })
  }
}

async function responseSnippet(response, limit = 1000) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - size
      chunks.push(value.subarray(0, remaining))
      size += Math.min(value.byteLength, remaining)
      if (value.byteLength >= remaining) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function readBoundedResponse(response, label, limit = MAX_RESPONSE_BYTES) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error(`${label} exceeded the ${limit}-byte response limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error })
  }
}

async function apiFetch(component, type, operation, input = {}, enforceCatalog = true) {
  const key = assertAllowedOperation(component, type, operation)
  return apiFetchOperation(component, type, operation, input, enforceCatalog, key)
}

// Dedicated wrappers may use a host-owned API operation after applying stricter typed validation. The
// generic catalog path always goes through apiFetch and therefore cannot reach these operations.
async function hostApiFetch(component, type, operation, input = {}) {
  return apiFetchOperation(component, type, operation, input, false, operationKey(component, type, operation))
}

async function apiFetchOperation(component, type, operation, input, enforceCatalog, key) {
  if (enforceCatalog && !apiCatalog.has(key))
    throw new Error(`operation is not present in this ZAP API catalog: ${key}`)

  const response = await zapFetch(
    apiUrl(component, type, operation, input),
    {
      headers: { Accept: type === "other" ? "*/*" : "application/json" },
    },
    `ZAP API ${key}`,
  )
  if (!response.ok)
    throw new Error(`ZAP API ${key} returned HTTP ${response.status}: ${await responseSnippet(response)}`)
  return boundedResponse(response, key)
}

function apiUrl(component, type, operation, input) {
  const format = type === "other" ? "OTHER" : "JSON"
  const url = new URL(`/${format}/${encodeURIComponent(component)}/${type}/${encodeURIComponent(operation)}/`, API_URL)
  url.searchParams.set("apikey", API_KEY)
  Object.entries(apiParameters(input)).forEach(([name, value]) => url.searchParams.set(name, value))
  return url
}

async function hostApiJson(component, type, operation, input = {}) {
  const key = operationKey(component, type, operation)
  const response = await zapFetch(
    apiUrl(component, type, operation, input),
    { headers: { Accept: "application/json" } },
    `ZAP API ${key}`,
  )
  if (!response.ok)
    throw new Error(`ZAP API ${key} returned HTTP ${response.status}: ${await responseSnippet(response)}`)
  return parseJson(await readBoundedResponse(response, `ZAP API ${key}`), `ZAP API ${key}`)
}

async function boundedResponse(response, label) {
  const data = await readBoundedResponse(response, `ZAP API ${label}`)
  const contentType = response.headers.get("content-type") || "application/octet-stream"
  if (data.byteLength > MAX_INLINE_BYTES || !/json|text|xml|html|javascript|x-pem-file/i.test(contentType)) {
    return storeContentAddressed(WORKAREA, data, { contentType, source: label })
  }
  const body = new TextDecoder().decode(data)
  if (/json/i.test(contentType)) {
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new Error(`ZAP API ${label} returned invalid JSON`, { cause: error })
    }
  }
  return body
}

async function discoverApiCatalog() {
  const index = await fetchApiUi("/UI")
  const components = Array.from(index.matchAll(/href=["']\/UI\/([^/"'<>]+)\/["']/gi))
    .map((match) => decodeURIComponent(match[1]))
    .filter((component, index, all) => all.indexOf(component) === index)
  const found = new Map()
  for (const catalogComponent of components) {
    const html = await fetchApiUi(`/UI/${encodeURIComponent(catalogComponent)}/`)
    for (const match of html.matchAll(/href=["']\/UI\/([^/"'<>]+)\/(view|action|other)\/([^/"'<>]+)\/["']/gi)) {
      const component = decodeURIComponent(match[1])
      const type = match[2].toLowerCase()
      const operation = decodeURIComponent(match[3])
      if (!isAllowedOperation(component, type, operation)) continue
      found.set(operationKey(component, type, operation), { component, type, operation })
    }
  }
  if (!found.size) throw new Error("ZAP returned an empty API catalog")
  return found
}

async function fetchApiUi(pathname) {
  const response = await zapFetch(
    new URL(pathname, API_URL),
    { headers: { Accept: "text/html", "X-ZAP-API-Key": API_KEY } },
    `ZAP API catalog ${pathname}`,
  )
  if (!response.ok) throw new Error(`ZAP API catalog ${pathname} returned HTTP ${response.status}`)
  return new TextDecoder().decode(await readBoundedResponse(response, `ZAP API catalog ${pathname}`, MAX_CATALOG_BYTES))
}

const NATIVE_TOOLS = [
  {
    name: "zap_api_catalog",
    description:
      "List the API operations exposed by the installed ZAP core and add-ons. Host lifecycle and API-security mutations are omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: {
          type: "string",
          description: "Optional component filter, for example core, spider, websocket, or oast.",
        },
        type: { type: "string", enum: ["view", "action", "other"] },
      },
    },
  },
  {
    name: "zap_api_call",
    description:
      "Call one operation returned by zap_api_catalog. Arbitrary URLs and host-owned lifecycle/security operations are rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: { type: "string" },
        type: { type: "string", enum: ["view", "action", "other"] },
        operation: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
      },
      required: ["component", "type", "operation"],
    },
  },
  {
    name: "zap_http_request",
    description:
      "Send or replay one complete raw HTTP request through ZAP. Absolute-form HTTP(S) requests are accepted directly; origin-form requests require target_url and are normalized without guessing the scheme. The recorded destination is verified after sending.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        request: {
          type: "string",
          description: "Raw HTTP request including request line, headers, blank line, and optional body.",
        },
        target_url: {
          type: "string",
          description:
            "Exact absolute HTTP(S) destination. Required for origin-form request lines and, when supplied with absolute-form, must match exactly.",
        },
        follow_redirects: { type: "boolean", default: false },
      },
      required: ["request"],
    },
  },
  {
    name: "zap_generate_scoped_report",
    description:
      "Generate a ZAP report inside the engagement workarea containing only the explicitly authorized HTTP(S) site origins.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string", description: "Path relative to the engagement root." },
        template: { type: "string", description: "Installed ZAP report template, for example traditional-json." },
        title: { type: "string" },
        sites: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Authorized site origins, for example https://example.com (no path or query).",
        },
      },
      required: ["file_path", "template", "title", "sites"],
    },
  },
  {
    name: "zap_history_search",
    description:
      "Return a bounded metadata-only page of HTTP history, optionally scoped to a base URL and filtered by a case-insensitive text pattern. Request and response bodies are opt-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_url: { type: "string" },
        start: { type: "integer", minimum: 0, default: 0 },
        count: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        search: { type: "string" },
        include_bodies: {
          type: "boolean",
          default: false,
          description: "Opt in to complete request/response pairs. Large results are stored once by content hash.",
        },
      },
    },
  },
  {
    name: "zap_history_get",
    description: "Read metadata for one ZAP history message. Request and response bodies are opt-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { oneOf: [{ type: "integer" }, { type: "string" }] },
        include_bodies: {
          type: "boolean",
          default: false,
          description: "Opt in to the complete request/response pair. Large results are stored once by content hash.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "zap_websocket_history",
    description: "Read a bounded page of WebSocket messages, optionally for one channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel_id: { oneOf: [{ type: "integer" }, { type: "string" }] },
        start: { type: "integer", minimum: 0, default: 0 },
        count: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: "zap_context_auth",
    description: "Call an installed context, authentication, session-management, users, or forced-user API operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: { type: "string", enum: ["context", "authentication", "sessionManagement", "users", "forcedUser"] },
        type: { type: "string", enum: ["view", "action"] },
        operation: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
      },
      required: ["component", "type", "operation"],
    },
  },
  {
    name: "zap_oast",
    description: "Call an installed OAST, callback, BOAST, or Interactsh API operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: { type: "string", enum: ["oast", "callback", "boast", "interactsh"] },
        type: { type: "string", enum: ["view", "action"] },
        operation: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
      },
      required: ["component", "type", "operation"],
    },
  },
  {
    name: "zap_prompt_get",
    description:
      "Resolve one official ZAP MCP prompt, including baseline and full scan workflows, into its prompt messages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: { type: "string" } } },
      required: ["name"],
    },
  },
]

async function nativeTool(name, args) {
  if (name === "zap_api_catalog") {
    return text(
      Array.from(apiCatalog.values()).filter(
        (item) => (!args.component || item.component === args.component) && (!args.type || item.type === args.type),
      ),
    )
  }
  if (name === "zap_api_call") return text(await apiFetch(args.component, args.type, args.operation, args.parameters))
  if (name === "zap_http_request") {
    const request = normalizedHttpRequest(args.request, args.target_url)
    assertZapUrlAllowed(ALLOWED_ORIGINS, request.targetUrl, "ZAP request")
    const result = await hostApiFetch("core", "action", "sendRequest", {
      request: request.request,
      followRedirects: args.follow_redirects === true,
    })
    const recordedUrl = recordedRequestTarget(result)
    if (recordedUrl !== request.targetUrl)
      throw new Error(`ZAP recorded ${recordedUrl}, not the validated destination ${request.targetUrl}`)
    return text({
      ...result,
      cyberful_request_target: {
        target_url: request.targetUrl,
        scheme: request.scheme,
        normalized_origin_form: request.normalizedOriginForm,
        recorded_url: recordedUrl,
      },
    })
  }
  if (name === "zap_generate_scoped_report") {
    const reportPath = engagementReportPath(args.file_path, WORKAREA)
    const sites = engagementReportSites(args.sites)
    await mkdir(path.dirname(reportPath.containerPath), { recursive: true })
    return withEngagementReportPath(
      text({
        response: await apiFetch("reports", "action", "generate", {
          title: args.title,
          template: args.template,
          sites: sites.join("|"),
          reportFileName: path.basename(reportPath.containerPath),
          reportDir: path.dirname(reportPath.containerPath),
          display: false,
        }),
        included_sites: sites,
      }),
      reportPath,
    )
  }
  if (name === "zap_history_search") {
    const result = await hostApiJson("core", "view", "messages", {
      baseurl: args.base_url || "",
      start: args.start ?? 0,
      count: Math.min(args.count ?? 100, 500),
    })
    const projected = projectHistory(result, { search: args.search, includeBodies: args.include_bodies === true })
    if (!args.include_bodies) return text(projected)
    const data = new TextEncoder().encode(JSON.stringify(projected))
    return text(
      data.byteLength > MAX_INLINE_BYTES
        ? await storeContentAddressed(WORKAREA, data, {
            contentType: "application/json",
            source: "core-view-messages",
          })
        : projected,
    )
  }
  if (name === "zap_history_get") {
    const result = await hostApiJson("core", "view", "message", { id: args.id })
    const value = args.include_bodies
      ? result
      : { message: messageMetadata(result?.message ?? result), cyberful_projection: "metadata" }
    if (!args.include_bodies) return text(value)
    const data = new TextEncoder().encode(JSON.stringify(value))
    return text(
      data.byteLength > MAX_INLINE_BYTES
        ? await storeContentAddressed(WORKAREA, data, {
            contentType: "application/json",
            source: `core-view-message-${args.id}`,
          })
        : value,
    )
  }
  if (name === "zap_websocket_history") {
    return text(
      await apiFetch(
        "websocket",
        "view",
        "messages",
        {
          channelId: args.channel_id,
          start: args.start ?? 0,
          count: Math.min(args.count ?? 100, 500),
          payloadPreviewLength: MAX_INLINE_BYTES,
        },
        false,
      ),
    )
  }
  if (name === "zap_context_auth" || name === "zap_oast") {
    return text(await apiFetch(args.component, args.type, args.operation, args.parameters))
  }
  if (name === "zap_prompt_get")
    return text(await upstream.getPrompt({ name: args.name, arguments: args.arguments || {} }))
  return text({ error: `unknown bridge tool ${name}` }, true)
}

const upstreamTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { Authorization: MCP_KEY } },
})
const upstream = new Client({ name: "cyberful-zap-bridge", version: "0.1.0" })
await upstream.connect(upstreamTransport)
const apiCatalog = await discoverApiCatalog()

const discoveredOfficialTools = []
let toolCursor
do {
  const page = await upstream.listTools(toolCursor ? { cursor: toolCursor } : undefined)
  discoveredOfficialTools.push(...page.tools)
  toolCursor = page.nextCursor
} while (toolCursor)
const officialTools = discoveredOfficialTools.map((tool) =>
  tool.name === "zap_generate_report"
    ? {
        ...tool,
        description: `${tool.description || "Generate a ZAP report."} Reports are confined to /zap/wrk, which maps to the engagement root; successful results include engagement_root_relative_path.`,
      }
    : tool,
)
const officialToolNames = new Set(officialTools.map((item) => item.name))

const server = new Server(
  { name: "cyberful-zap", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...officialTools, ...NATIVE_TOOLS.filter((item) => !officialToolNames.has(item.name))],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (officialToolNames.has(request.params.name)) {
      assertScopedZapTool(request.params.name, request.params.arguments || {}, ALLOWED_ORIGINS, true)
      const reportPath =
        request.params.name === "zap_generate_report"
          ? engagementReportPath(request.params.arguments?.file_path, WORKAREA)
          : undefined
      const result = await upstream.callTool(
        {
          name: request.params.name,
          arguments: reportPath
            ? { ...(request.params.arguments || {}), file_path: reportPath.containerPath }
            : request.params.arguments || {},
        },
        undefined,
        { timeout: 600_000, maxTotalTimeout: 600_000 },
      )
      return reportPath ? withEngagementReportPath(result, reportPath) : result
    }
    const args = request.params.arguments || {}
    assertScopedZapTool(request.params.name, args, ALLOWED_ORIGINS)
    return await nativeTool(request.params.name, args)
  } catch (error) {
    return text({ error: message(error) }, true)
  }
})
server.setRequestHandler(ListResourcesRequestSchema, (request) => upstream.listResources(request.params))
server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
  const result = await upstream.listResourceTemplates(request.params).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === -32601) return undefined
    throw error
  })
  return result ?? { resourceTemplates: [] }
})
server.setRequestHandler(ReadResourceRequestSchema, (request) => upstream.readResource(request.params))
server.setRequestHandler(ListPromptsRequestSchema, (request) => upstream.listPrompts(request.params))
server.setRequestHandler(GetPromptRequestSchema, (request) => upstream.getPrompt(request.params))

// ── Bridge Shutdown Has One Idempotent Owner ────────────────────────
// Stdio EOF and process signals can race while the upstream HTTP transport is
// still active. Retained promises serialize both close operations and make every
// repeated shutdown request observe the same completion. Signal exits wait for
// that ownership chain, while transport failures are reported only on stderr.
// ────────────────────────────────────────────────────────────────────

let upstreamShutdown
let bridgeShutdown
let bridgeSignalShutdown
let serverCloseShutdown
function closeUpstream() {
  upstreamShutdown ??= upstream.close()
  return upstreamShutdown
}

function closeBridge() {
  bridgeShutdown ??= Promise.allSettled([closeUpstream(), server.close()]).then((results) => {
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
    if (failures.length) throw new AggregateError(failures, "ZAP bridge shutdown failed")
  })
  return bridgeShutdown
}

function closeBridgeForSignal(signal) {
  bridgeSignalShutdown ??= closeBridge().then(
    () => process.exit(0),
    (error) => {
      console.error(`${signal} shutdown failed: ${message(error)}`)
      process.exit(1)
    },
  )
}

server.onclose = () => {
  serverCloseShutdown ??= closeUpstream().catch((error) => {
    console.error(`stdio shutdown failed: ${message(error)}`)
  })
}
process.once("SIGINT", () => closeBridgeForSignal("SIGINT"))
process.once("SIGTERM", () => closeBridgeForSignal("SIGTERM"))

await server.connect(new StdioServerTransport())
