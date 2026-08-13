// ── Passive Egress Observation ──────────────────────────────────
// Redacts network metadata from gateway and shell calls into a local audit row;
// observation failure never changes, retries, redirects, or blocks the operation.
// → cyberful/src/subsystem/gateway/tool-usage.ts — persists the metadata-only row.
// → mcps/cyberful-os/cyberful_os_mcp.py — supplies optional direct-route metadata.
// @docs/runtimes/cyberful-os.md
// ─────────────────────────────────────────────────────────────────

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { isRecord } from "@/util/record"
import type { ToolUsageEvent } from "./tool-usage"

const META_KEY = "cyberful.dev/egress"
const DYNAMIC_SEGMENT = /^(?:\d+|[a-f0-9]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i
const OPAQUE_SEGMENT = /^[a-zA-Z0-9_-]{20,}$/

type Observation = Pick<
  ToolUsageEvent,
  | "egress_host"
  | "egress_method"
  | "egress_http_status"
  | "egress_path_family"
  | "egress_request_bytes"
  | "egress_response_bytes"
  | "egress_attempts"
  | "egress_redirects"
  | "egress_deadline_ms"
  | "egress_route"
  | "egress_observability"
  | "egress_destination_changed"
>

function boundedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function httpStatus(value: unknown): number | undefined {
  const status = boundedInteger(value)
  return status !== undefined && status >= 100 && status <= 599 ? status : undefined
}

function safeMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const method = value.trim().toUpperCase()
  return /^[A-Z]{2,20}$/.test(method) ? method : undefined
}

function safeHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const host = value.trim().toLowerCase().replace(/\.$/, "")
  return host && host.length <= 253 && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : undefined
}

export function pathFamily(value: string): string {
  const segments = value
    .split("/")
    .filter(Boolean)
    .slice(0, 4)
    .map((segment) => {
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        decoded = segment
      }
      if (decoded === ":id" || decoded === ":segment") return decoded
      if (decoded.includes("@") || DYNAMIC_SEGMENT.test(decoded) || OPAQUE_SEGMENT.test(decoded)) return ":id"
      const redacted = decoded.replace(/[^a-zA-Z0-9._~-]/g, "-").slice(0, 40)
      return redacted || ":segment"
    })
  return `/${segments.join("/")}`.slice(0, 180) || "/"
}

function fromUrl(value: unknown): Pick<Observation, "egress_host" | "egress_path_family"> {
  if (typeof value !== "string") return {}
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return {}
    return { egress_host: safeHost(url.host), egress_path_family: pathFamily(url.pathname) }
  } catch {
    return {}
  }
}

function firstUrl(args: Record<string, unknown>): unknown {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && /(?:url|uri|target|endpoint)$/i.test(key) && /^https?:\/\//i.test(value))
      return value
  }
  return undefined
}

function fromMetadata(result: CallToolResult): Observation | undefined {
  if (!isRecord(result._meta) || !isRecord(result._meta[META_KEY])) return undefined
  const value = result._meta[META_KEY]
  const observation = typeof value.observability === "string" ? value.observability : undefined
  const observability =
    observation === "not_applicable" ||
    observation === "observed" ||
    observation === "declared" ||
    observation === "inferred" ||
    observation === "degraded"
      ? observation
      : "degraded"
  const hostAndPath = {
    egress_host: safeHost(value.host),
    egress_path_family: typeof value.path_family === "string" ? pathFamily(value.path_family) : undefined,
  }
  return {
    ...hostAndPath,
    egress_method: safeMethod(value.method),
    egress_http_status: httpStatus(value.status),
    egress_request_bytes: boundedInteger(value.request_bytes),
    egress_response_bytes: boundedInteger(value.response_bytes),
    egress_attempts: boundedInteger(value.attempts),
    egress_redirects: boundedInteger(value.redirects),
    egress_deadline_ms: boundedInteger(value.deadline_ms),
    egress_route: typeof value.route === "string" ? value.route.trim().slice(0, 120) : undefined,
    egress_observability: observability,
    egress_destination_changed:
      typeof value.destination_changed === "boolean" ? value.destination_changed : undefined,
  }
}

function inferredRoute(tool: string): string | undefined {
  if (tool === "shell" || tool.startsWith("nmap") || tool.startsWith("nuclei")) return "cyberful-os/docker-direct"
  if (tool.startsWith("browser_")) return "browser/zap"
  if (tool.startsWith("zap_")) return "zap"
  return undefined
}

// ── Missing Telemetry Is A Recorded Degradation, Never A Gate ───
// Metadata is collected only after the upstream call returns or fails. The
// destination is not compared with an allowlist and cannot affect execution.
// When a tool cannot expose method or byte counters, the row retains its known
// route and marks observability degraded instead of inventing proof or turning a
// collector problem into a target-traffic decision.
// ─────────────────────────────────────────────────────────────────
export function observe(tool: string, args: Record<string, unknown>, result: CallToolResult): Observation | undefined {
  const metadata = fromMetadata(result)
  if (metadata) return metadata
  const route = inferredRoute(tool)
  const endpoint = fromUrl(firstUrl(args))
  if (!route && !endpoint.egress_host) return undefined
  const timeoutSeconds = boundedInteger(args.timeout_seconds)
  return {
    ...endpoint,
    egress_method: safeMethod(args.method) ?? (tool === "browser_navigate" ? "GET" : undefined),
    egress_deadline_ms:
      boundedInteger(args.timeout_ms) ?? (timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000),
    egress_route: route,
    egress_observability: endpoint.egress_host ? "inferred" : "degraded",
  }
}

export function declared(args: Record<string, unknown>): Observation {
  const endpoint = {
    egress_host: safeHost(args.host),
    egress_path_family: typeof args.path_family === "string" ? pathFamily(args.path_family) : undefined,
  }
  if (!endpoint.egress_host) throw new Error("egress_observation requires a redacted destination host")
  const observation = args.observability
  if (
    observation !== "not_applicable" &&
    observation !== "observed" &&
    observation !== "declared" &&
    observation !== "inferred" &&
    observation !== "degraded"
  )
    throw new Error("egress_observation observability is invalid")
  return {
    ...endpoint,
    egress_method: safeMethod(args.method),
    egress_http_status: httpStatus(args.http_status),
    egress_request_bytes: boundedInteger(args.request_bytes),
    egress_response_bytes: boundedInteger(args.response_bytes),
    egress_attempts: boundedInteger(args.attempts),
    egress_redirects: boundedInteger(args.redirects),
    egress_deadline_ms: boundedInteger(args.deadline_ms),
    egress_route: typeof args.route === "string" ? args.route.trim().slice(0, 120) : undefined,
    egress_observability: observation,
    egress_destination_changed:
      typeof args.destination_changed === "boolean" ? args.destination_changed : undefined,
  }
}

export const EGRESS_OBSERVATION_TOOL_DEF = {
  name: "egress_observation",
  description:
    "Append redacted metadata after a network-bearing shell PoC: host, method, HTTP status, path family, bytes, attempts, redirects, deadline and actual route. This is passive, local and fail-open; it never allows, blocks, rewrites, redirects, approves, or retries traffic, including when the destination changed.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      host: { type: "string", maxLength: 253 },
      method: { type: "string", maxLength: 20 },
      http_status: { type: "integer", minimum: 100, maximum: 599 },
      path_family: { type: "string", maxLength: 180 },
      request_bytes: { type: "integer", minimum: 0 },
      response_bytes: { type: "integer", minimum: 0 },
      attempts: { type: "integer", minimum: 0 },
      redirects: { type: "integer", minimum: 0 },
      deadline_ms: { type: "integer", minimum: 0 },
      route: { type: "string", maxLength: 120 },
      observability: { type: "string", enum: ["not_applicable", "observed", "declared", "inferred", "degraded"] },
      destination_changed: { type: "boolean" },
    },
    required: ["host", "observability"],
  },
}

export * as EgressObservation from "./egress-observation"
