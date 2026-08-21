// ── Incremental ZAP History Collector ───────────────────────────
// Pages the existing metadata-only zap_history_search tool without exposing
//   host-owned calls to the model. The persisted cursor is advanced only after
//   coverage records are durable, making crash replay safe through set summaries.
// → cyberful/src/subsystem/gateway/surface-coverage.ts — owns redacted observations.
// → mcps/zap/zap_bridge.mjs — provides the passive history projection.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { isRecord } from "@/util/record"
import { pathFamily } from "./egress-observation"
import { httpHostIsAuthorized, type EngagementPolicy } from "./engagement-policy"
import { type HttpSurfaceObservation, SurfaceCoverage } from "./surface-coverage"

const PAGE_SIZE = 100
const MIN_PAGE_SIZE = 1

export type ZapHistoryFailureCode =
  | "ZAP_HISTORY_RESPONSE_TOO_LARGE"
  | "ZAP_HISTORY_STORAGE_EXHAUSTED"
  | "ZAP_HISTORY_TOOL_ERROR"
  | "ZAP_HISTORY_INVALID_PROJECTION"
  | "ZAP_HISTORY_TRANSPORT_FAILED"

class ZapHistoryCollectionError extends Error {
  readonly code: ZapHistoryFailureCode

  constructor(code: ZapHistoryFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "ZapHistoryCollectionError"
    this.code = code
  }
}

type Search = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>
type TransportFailure = (error: unknown, signal?: AbortSignal) => Promise<void>

function textPayload(result: CallToolResult): unknown {
  const body = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")
  if (result.isError) {
    const code = /exceeded the [0-9]+-byte response limit/iu.test(body)
      ? "ZAP_HISTORY_RESPONSE_TOO_LARGE"
      : /data cache size limit is reached/iu.test(body)
        ? "ZAP_HISTORY_STORAGE_EXHAUSTED"
        : "ZAP_HISTORY_TOOL_ERROR"
    throw new ZapHistoryCollectionError(code, `zap_history_search failed with ${code}`)
  }
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new ZapHistoryCollectionError(
      "ZAP_HISTORY_INVALID_PROJECTION",
      "zap_history_search returned invalid JSON",
      error,
    )
  }
}

function safeMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const method = value.trim().toUpperCase()
  return /^[A-Z]{2,20}$/.test(method) ? method : undefined
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function observation(value: unknown, policy: EngagementPolicy): HttpSurfaceObservation | undefined {
  if (!isRecord(value) || (typeof value.id !== "string" && typeof value.id !== "number") || typeof value.url !== "string") return
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    return
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  const status = safeStatus(value.status_code)
  const responseHeaderBytes = typeof value.response_header_bytes === "number" ? value.response_header_bytes : 0
  const responseBodyBytes = typeof value.response_body_bytes === "number" ? value.response_body_bytes : 0
  return {
    zapID: String(value.id).slice(0, 128),
    origin: url.origin,
    pathFamily: pathFamily(url.pathname),
    method: safeMethod(value.method),
    status,
    hasResponse: status !== undefined || responseHeaderBytes > 0 || responseBodyBytes > 0,
    inScope: httpHostIsAuthorized(url.hostname, policy.authorized_http_hosts),
  }
}

export class ZapHistoryCollector {
  readonly #coverage: SurfaceCoverage
  readonly #cursorPath: string
  readonly #search: Search
  readonly #transportFailure?: TransportFailure
  #cursor: number | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(
    workareaRoot: string,
    coverage: SurfaceCoverage,
    search: Search,
    transportFailure?: TransportFailure,
  ) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("ZAP history collector requires an absolute workarea root")
    this.#coverage = coverage
    this.#search = search
    this.#transportFailure = transportFailure
    this.#cursorPath = path.join(workareaRoot, "raw", "operations", "zap-history-coverage.cursor.json")
  }

  sync(policy: EngagementPolicy | undefined, signal?: AbortSignal): Promise<void> {
    if (!policy) return Promise.resolve()
    const pending = this.#queue.then(async () => {
      try {
        let start = await this.#readCursor()
        let pageSize = PAGE_SIZE
        while (true) {
          let result: CallToolResult
          try {
            result = await this.#search({ start, count: pageSize, include_bodies: false }, signal)
          } catch (error) {
            await this.#transportFailure?.(error, signal).catch(() => undefined)
            throw new ZapHistoryCollectionError(
              "ZAP_HISTORY_TRANSPORT_FAILED",
              "zap_history_search transport failed",
              error,
            )
          }
          let payload: unknown
          try {
            payload = textPayload(result)
          } catch (error) {
            if (
              error instanceof ZapHistoryCollectionError &&
              error.code === "ZAP_HISTORY_RESPONSE_TOO_LARGE" &&
              pageSize > MIN_PAGE_SIZE
            ) {
              pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2))
              continue
            }
            throw error
          }
          if (!isRecord(payload) || !Array.isArray(payload.messages))
            throw new ZapHistoryCollectionError(
              "ZAP_HISTORY_INVALID_PROJECTION",
              "zap_history_search returned an invalid projection",
            )
          const returned = typeof payload.returned === "number" && Number.isInteger(payload.returned)
            ? payload.returned
            : payload.messages.length
          if (returned < 0 || returned > pageSize || returned !== payload.messages.length)
            throw new ZapHistoryCollectionError(
              "ZAP_HISTORY_INVALID_PROJECTION",
              "zap_history_search returned inconsistent pagination metadata",
            )
          const records = payload.messages.flatMap((message) => {
            const decoded = observation(message, policy)
            return decoded ? [decoded] : []
          })
          await this.#coverage.observeHttpSurface(records)
          start += returned
          await this.#writeCursor(start)
          if (returned < pageSize) break
        }
        await this.#coverage.setCollectorState("ok")
      } catch (error) {
        const failure = error instanceof ZapHistoryCollectionError
          ? error
          : new ZapHistoryCollectionError("ZAP_HISTORY_TOOL_ERROR", "zap_history_search failed", error)
        await this.#coverage.setCollectorState("degraded", {
          code: failure.code,
          cursor: await this.#readCursor().catch(() => 0),
        }).catch(() => undefined)
      }
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  close(policy: EngagementPolicy | undefined): Promise<void> {
    return this.sync(policy).then(() => this.#queue)
  }

  async #readCursor() {
    if (this.#cursor !== undefined) return this.#cursor
    const content = await readFile(this.#cursorPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (content === undefined) return (this.#cursor = 0)
    try {
      const value: unknown = JSON.parse(content)
      if (
        isRecord(value) &&
        value.version === 1 &&
        typeof value.next_start === "number" &&
        Number.isInteger(value.next_start) &&
        value.next_start >= 0
      )
        return (this.#cursor = value.next_start)
    } catch {
      // A missing or corrupt cursor deliberately replays history from the start.
    }
    return (this.#cursor = 0)
  }

  async #writeCursor(nextStart: number) {
    await mkdir(path.dirname(this.#cursorPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.#cursorPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, next_start: nextStart }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, this.#cursorPath)
    this.#cursor = nextStart
  }
}

export * as GatewayZapHistoryCollector from "./zap-history-collector"
