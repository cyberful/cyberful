#!/usr/bin/env bun
// ── Unrestricted ZAP MCP Bridge ─────────────────────────────────────
// Speaks stdio MCP to Cyberful, forwards the official ZAP MCP surface, and
// adds bounded wrappers over the catalog discovered from this ZAP instance.
// Target scope and operation choice remain agent-owned; the bridge exposes the
// complete catalog while retaining transport, response, and workarea safety.
// → mcps/zap/zap_policy.mjs — normalizes generic API requests.
// ────────────────────────────────────────────────────────────────────

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
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
  apiOperationContract,
  operationKey,
  validatedApiParameters,
  ZapApiContractError,
  zapApiResponseError,
} from "./zap_policy.mjs"
import { normalizedHttpRequest, recordedRequestTarget, recordedResponseStatus } from "./zap_http_request.mjs"
import { replayRequest } from "./zap_history_replay.mjs"
import { engagementReportPath, withEngagementReportPath } from "./zap_report_path.mjs"
import { messageMetadata, projectHistory, storeContentAddressed } from "./zap_history.mjs"
import { completedOastCall, oastCapabilities, oastToolDefinition, resolveOastOperation } from "./zap_oast.mjs"
import { ZAP_BRIDGE_TOOLS } from "./zap_tool_catalog.mjs"

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

function text(value, isError = false, metadata = undefined) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
    ...(metadata ? { _meta: metadata } : {}),
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
  const key = operationKey(component, type, operation)
  return apiFetchOperation(component, type, operation, input, enforceCatalog, key)
}

// Dedicated wrappers may use an operation before or independently from catalog discovery.
async function hostApiFetch(component, type, operation, input = {}) {
  return apiFetchOperation(component, type, operation, input, false, operationKey(component, type, operation))
}

async function apiFetchOperation(component, type, operation, input, enforceCatalog, key) {
  if (enforceCatalog && !apiCatalog.has(key))
    throw new ZapApiContractError(
      "ZAP_OPERATION_UNAVAILABLE",
      key,
      `Operation is not present in this ZAP API catalog: ${key}`,
      Array.from(apiCatalog.keys()).filter((candidate) => candidate.startsWith(`${component}:${type}:`)),
    )
  const parameters = validatedApiParameters(key, input)

  const response = await zapFetch(
    apiUrl(component, type, operation, parameters),
    {
      headers: { Accept: type === "other" ? "*/*" : "application/json" },
    },
    `ZAP API ${key}`,
  )
  if (!response.ok)
    throw zapApiResponseError(key, response.status, await responseSnippet(response))
  return boundedResponse(response, key)
}

function apiUrl(component, type, operation, input) {
  const format = type === "other" ? "OTHER" : "JSON"
  const url = new URL(`/${format}/${encodeURIComponent(component)}/${type}/${encodeURIComponent(operation)}/`, API_URL)
  url.searchParams.set("apikey", API_KEY)
  Object.entries(input).forEach(([name, value]) => url.searchParams.set(name, value))
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

async function nativeTool(name, args) {
  if (name === "zap_api_catalog") {
    return text(
      Array.from(apiCatalog.entries())
        .filter(
          ([, item]) =>
            (!args.component || item.component === args.component) && (!args.type || item.type === args.type),
        )
        .map(([key, item]) => {
          const contract = apiOperationContract(key)
          return {
            ...item,
            ...(contract
              ? {
                  requiredParameters: contract.required,
                  optionalParameters: contract.optional,
                }
              : {}),
          }
        }),
    )
  }
  if (name === "zap_api_call") return text(await apiFetch(args.component, args.type, args.operation, args.parameters))
  if (name === "zap_http_request") {
    const request = normalizedHttpRequest(args.request, args.target_url)
    const result = await hostApiFetch("core", "action", "sendRequest", {
      request: request.request,
      followRedirects: args.follow_redirects === true,
    })
    const recordedUrl = recordedRequestTarget(result)
    const destination = new URL(recordedUrl)
    const status = recordedResponseStatus(result)
    return text(
      {
        ...result,
        cyberful_request_target: {
          target_url: request.targetUrl,
          scheme: request.scheme,
          normalized_origin_form: request.normalizedOriginForm,
          recorded_url: recordedUrl,
        },
      },
      false,
      {
        "cyberful.dev/egress": {
          version: 1,
          route: "zap",
          observability: status === undefined ? "degraded" : "observed",
          host: destination.host,
          method: request.request.split(/\s+/, 1)[0],
          path_family: destination.pathname,
          ...(status === undefined ? {} : { status }),
          attempts: 1,
        },
      },
    )
  }
  if (name === "zap_generate_workarea_report") {
    const reportPath = engagementReportPath(args.file_path, WORKAREA)
    await mkdir(path.dirname(reportPath.containerPath), { recursive: true })
    return withEngagementReportPath(
      text({
        response: await apiFetch("reports", "action", "generate", {
          title: args.title,
          template: args.template,
          reportFileName: path.basename(reportPath.containerPath),
          reportDir: path.dirname(reportPath.containerPath),
          display: false,
        }),
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
  if (name === "zap_history_replay") {
    const source = await hostApiJson("core", "view", "message", { id: args.id })
    const message = source?.message ?? source
    const replay = replayRequest(message, args)
    const result = await hostApiFetch("core", "action", "sendRequest", {
      request: replay.request,
      followRedirects: args.follow_redirects === true,
    })
    const sent = result?.sendRequest?.[0]
    if (!sent) throw new Error("ZAP sendRequest returned no replay message")
    const metadata = messageMetadata(sent)
    const target = new URL(replay.targetUrl)
    return text({
      source_id: args.id,
      replay_id: metadata.id,
      target: `${target.origin}${target.pathname}`,
      mutation_summary: replay.mutationSummary,
      response: metadata,
      response_sha256: createHash("sha256").update(typeof sent.responseBody === "string" ? sent.responseBody : "").digest("hex"),
      cyberful_projection: "metadata",
    })
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
  if (name === "zap_context_auth") {
    return text(await apiFetch(args.component, args.type, args.operation, args.parameters))
  }
  if (name === "zap_oast") {
    const operation = resolveOastOperation(apiCatalog, args)
    if (!operation) return text(oastCapabilities(apiCatalog))
    const result = await apiFetch(operation.component, operation.type, operation.operation, args.parameters)
    return text(completedOastCall(operation, result))
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
const nativeTools = [...ZAP_BRIDGE_TOOLS, oastToolDefinition(apiCatalog)]

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
  tools: [...officialTools, ...nativeTools.filter((item) => !officialToolNames.has(item.name))],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (officialToolNames.has(request.params.name)) {
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
    return await nativeTool(request.params.name, args)
  } catch (error) {
    if (error instanceof ZapApiContractError)
      return text(
        {
          error: {
            code: error.code,
            path: error.path,
            expected: "an operation and parameters supported by the installed ZAP catalog",
            receivedType: "invalid",
            retryable: true,
            hint: error.message,
            ...(error.alternatives.length > 0 ? { alternatives: error.alternatives } : {}),
          },
        },
        true,
      )
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
