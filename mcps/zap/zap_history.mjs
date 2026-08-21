// ── Redacted ZAP History Projection ─────────────────────────────────
// Converts ZAP messages into bounded metadata, adaptively pages oversized
// history reads, and stores opted-in bodies by content hash in the workarea.
// → mcps/zap/zap_bridge.mjs — exposes these projections through stdio MCP.
// @docs/runtimes/zap.md
// ────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, rm } from "node:fs/promises"
import path from "node:path"

function text(value) {
  return typeof value === "string" ? value : ""
}

function firstLine(value) {
  return text(value).split(/\r?\n/, 1)[0] || ""
}

function requestTarget(message) {
  const [method, target] = firstLine(message.requestHeader).split(/\s+/, 3)
  if (!target) return { method: method || undefined, url: typeof message.url === "string" ? message.url : undefined }
  if (/^https?:\/\//i.test(target)) return { method, url: target }
  const host = text(message.requestHeader)
    .match(/^Host:\s*([^\r\n]+)/im)?.[1]
    ?.trim()
  return { method, url: host ? `${message.tls === "true" ? "https" : "http"}://${host}${target}` : target }
}

function responseStatus(message) {
  const [, statusCode, ...reason] = firstLine(message.responseHeader).split(/\s+/)
  return {
    status_code: statusCode && /^\d{3}$/.test(statusCode) ? Number(statusCode) : undefined,
    reason: reason.length ? reason.join(" ") : undefined,
  }
}

export function messageMetadata(message) {
  const request = requestTarget(message)
  const response = responseStatus(message)
  const rtt = Number(message.rtt)
  return {
    id: message.id,
    type: message.type,
    timestamp: message.timestamp ?? message.requestTimestamp,
    rtt_ms: Number.isFinite(rtt) ? rtt : undefined,
    method: request.method,
    url: request.url,
    status_code: response.status_code,
    reason: response.reason,
    request_header_bytes: Buffer.byteLength(text(message.requestHeader)),
    request_body_bytes: Buffer.byteLength(text(message.requestBody)),
    response_header_bytes: Buffer.byteLength(text(message.responseHeader)),
    response_body_bytes: Buffer.byteLength(text(message.responseBody)),
  }
}

export function projectHistory(result, options = {}) {
  const messages = Array.isArray(result?.messages) ? result.messages : []
  const needle = typeof options.search === "string" && options.search ? options.search.toLowerCase() : undefined
  const matching = needle
    ? messages.filter((message) => JSON.stringify(message).toLowerCase().includes(needle))
    : messages
  return {
    messages: options.includeBodies ? matching : matching.map(messageMetadata),
    cyberful_projection: options.includeBodies ? "complete" : "metadata",
    returned: matching.length,
  }
}

// ── Metadata Queries Never Require One Unbounded ZAP Page ──────────
// ZAP's core messages view includes complete headers and bodies even when the
// caller needs metadata only, so a nominally small result can exceed the bridge
// response ceiling before projection. Metadata reads therefore consume several
// bounded upstream pages and project each one immediately. Complete-body reads
// retain a single adaptive page so retained body data stays under the same
// transport ceiling instead of multiplying it across an aggregate request.
//
// @docs/runtimes/zap.md
// ──────────────────────────────────────────────────────────────────────────────

function historyMessages(result) {
  if (!Array.isArray(result?.messages)) throw new Error("ZAP core:view:messages returned an invalid messages array")
  return result.messages
}

function responseTooLarge(error) {
  return error instanceof Error && /exceeded the [0-9]+-byte response limit/iu.test(error.message)
}

async function adaptivePage(fetchPage, start, requestedCount) {
  let count = requestedCount
  while (true) {
    try {
      const messages = historyMessages(await fetchPage({ start, count }))
      if (messages.length > count) throw new Error("ZAP core:view:messages returned more messages than requested")
      return { messages, count }
    } catch (error) {
      if (!responseTooLarge(error) || count === 1) throw error
      count = Math.max(1, Math.floor(count / 2))
    }
  }
}

export async function adaptiveHistoryProjection(fetchPage, options = {}) {
  if (typeof fetchPage !== "function") throw new Error("ZAP history paging requires a fetch function")
  const start = options.start ?? 0
  const requestedCount = options.count ?? 100
  const maxMetadataPageSize = options.maxMetadataPageSize ?? 100
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("ZAP history start must be a non-negative integer")
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0)
    throw new Error("ZAP history count must be a positive integer")
  if (!Number.isSafeInteger(maxMetadataPageSize) || maxMetadataPageSize <= 0)
    throw new Error("ZAP history metadata page size must be a positive integer")

  if (options.includeBodies === true) {
    const page = await adaptivePage(fetchPage, start, requestedCount)
    const projected = projectHistory({ messages: page.messages }, { search: options.search, includeBodies: true })
    return {
      ...projected,
      requested_count: requestedCount,
      scanned: page.messages.length,
      next_start: start + page.messages.length,
      upstream_page_size: page.count,
      page_size_reduced: page.count < requestedCount,
    }
  }

  const messages = []
  let nextStart = start
  let remaining = requestedCount
  let upstreamPageSize = Math.min(requestedCount, maxMetadataPageSize)
  let scanned = 0
  while (remaining > 0) {
    const requestedPageSize = Math.min(remaining, upstreamPageSize)
    const page = await adaptivePage(fetchPage, nextStart, requestedPageSize)
    if (page.count < requestedPageSize) upstreamPageSize = page.count
    messages.push(...projectHistory({ messages: page.messages }, { search: options.search }).messages)
    scanned += page.messages.length
    nextStart += page.messages.length
    remaining -= page.messages.length
    if (page.messages.length < page.count) break
  }
  return {
    messages,
    cyberful_projection: "metadata",
    returned: messages.length,
    requested_count: requestedCount,
    scanned,
    next_start: nextStart,
    upstream_page_size: upstreamPageSize,
    page_size_reduced: upstreamPageSize < Math.min(requestedCount, maxMetadataPageSize),
  }
}

export async function storeContentAddressed(workarea, data, metadata = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const directory = path.join(workarea, "raw", "zap", "history", "objects")
  const file = path.join(directory, `${sha256}.json`)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${sha256}.${randomUUID()}.tmp`)
  const artifact = await open(temporary, "wx", 0o600)
  await artifact.writeFile(bytes).finally(() => artifact.close())
  let deduplicated = false
  await link(temporary, file)
    .catch((error) => {
      if (error?.code === "EEXIST") {
        deduplicated = true
        return
      }
      throw error
    })
    .finally(() => rm(temporary, { force: true }))
  return {
    saved: path.relative(workarea, file),
    bytes: bytes.byteLength,
    sha256,
    deduplicated,
    ...metadata,
  }
}
