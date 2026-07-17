// ── Redacted ZAP History Projection ─────────────────────────────────
// Converts ZAP messages into bounded metadata, stores opted-in bodies by
// content hash inside the engagement workarea, and projects paginated history.
// → mcps/zap/zap_bridge.mjs — exposes these projections through stdio MCP.
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

export async function storeContentAddressed(workarea, data, metadata = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const directory = path.join(workarea, ".cyberful-zap", "objects")
  const file = path.join(directory, sha256)
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
