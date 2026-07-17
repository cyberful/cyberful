// ── TUI Worker RPC Contract ─────────────────────────────────────
// Defines and validates every request, result, and event that crosses between
//   the terminal process and its control-plane worker.
// → cyberful/src/cli/cmd/tui/thread.ts — owns the client endpoint.
// → cyberful/src/cli/cmd/tui/worker.ts — implements the server endpoint.
// ─────────────────────────────────────────────────────────────────

import type { GlobalEvent } from "@/server/client"
import { isRecord } from "@/util/record"
import { Rpc } from "@/util/rpc"

const MAX_BODY_CHARACTERS = 16 * 1024 * 1024
const MAX_DIRECTORY_CHARACTERS = 32_768
const MAX_HEADER_COUNT = 256
const MAX_HEADER_CHARACTERS = 128 * 1024
const MAX_PATH_CHARACTERS = 4_096
const MAX_RESOURCE_COUNT = 4_096
const MAX_RESOURCE_NAME_CHARACTERS = 256
const MAX_URL_CHARACTERS = 16_384
const HTTP_METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export type DockerResource = {
  name: string
  action: "remove" | "stop"
  kind: "expert" | "zap" | "dependency"
}

function fail(label: string, expectation: string): never {
  throw new TypeError(`${label} ${expectation}`)
}

function record(value: unknown, label: string) {
  if (!isRecord(value)) fail(label, "must be an object")
  return value
}

function string(value: unknown, label: string, maximum: number, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    fail(label, `must contain ${allowEmpty ? "0" : "1"}-${maximum} characters`)
  }
  return value
}

function optionalString(value: unknown, label: string, maximum: number) {
  if (value === undefined) return undefined
  return string(value, label, maximum)
}

function voidValue(value: unknown) {
  if (value !== undefined && value !== null) fail("RPC void value", "must be null or undefined")
  return undefined
}

function httpURL(value: unknown, label: string) {
  const source = string(value, label, MAX_URL_CHARACTERS)
  if (!URL.canParse(source)) fail(label, "must be an absolute URL")
  const parsed = new URL(source)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(label, "must use http or https")
  }
  return source
}

function headers(value: unknown, label: string) {
  const source = record(value, label)
  const entries = Object.entries(source)
  if (entries.length > MAX_HEADER_COUNT) fail(label, `must contain at most ${MAX_HEADER_COUNT} entries`)

  let characters = 0
  const result: Record<string, string> = {}
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string") fail(`${label}.${name}`, "must be a string")
    try {
      new Headers([[name, headerValue]])
    } catch {
      fail(`${label}.${name}`, "must be a valid HTTP header")
    }
    characters += name.length + headerValue.length
    if (characters > MAX_HEADER_CHARACTERS) {
      fail(label, `must contain at most ${MAX_HEADER_CHARACTERS} characters`)
    }
    result[name] = headerValue
  }
  return result
}

function fetchInput(value: unknown) {
  const source = record(value, "fetch input")
  const method = string(source.method, "fetch method", 32)
  if (!HTTP_METHOD.test(method)) fail("fetch method", "must be a valid HTTP token")
  return {
    url: httpURL(source.url, "fetch URL"),
    method,
    headers: headers(source.headers, "fetch headers"),
    body: optionalString(source.body, "fetch body", MAX_BODY_CHARACTERS),
  }
}

function fetchResult(value: unknown) {
  const source = record(value, "fetch result")
  if (
    typeof source.status !== "number" ||
    !Number.isSafeInteger(source.status) ||
    source.status < 100 ||
    source.status > 599
  ) {
    fail("fetch status", "must be an integer from 100 through 599")
  }
  return {
    status: source.status,
    headers: headers(source.headers, "response headers"),
    body: string(source.body, "response body", MAX_BODY_CHARACTERS, true),
  }
}

function snapshotResult(value: unknown) {
  return string(value, "snapshot path", MAX_PATH_CHARACTERS)
}

function serverInput(value: unknown) {
  const source = record(value, "server input")
  if (
    typeof source.port !== "number" ||
    !Number.isSafeInteger(source.port) ||
    source.port < 0 ||
    source.port > 65_535
  ) {
    fail("server port", "must be an integer from 0 through 65535")
  }
  return { port: source.port }
}

function serverResult(value: unknown) {
  const source = record(value, "server result")
  return { url: httpURL(source.url, "server URL") }
}

function isGlobalPayload(value: unknown): value is GlobalEvent["payload"] {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) return false
  if (value.type === "sync") {
    return (
      typeof value.name === "string" &&
      typeof value.id === "string" &&
      typeof value.seq === "number" &&
      Number.isFinite(value.seq) &&
      typeof value.aggregateID === "string" &&
      isRecord(value.data)
    )
  }
  return typeof value.id === "string" && value.id.length > 0 && isRecord(value.properties)
}

function globalPayload(value: unknown) {
  const source = record(value, "global event payload")
  if (source.type === "sync" && source.syncEvent !== undefined) {
    const projected = record(source.syncEvent, "projected event")
    const normalized: unknown = {
      type: "sync",
      name: string(projected.type, "projected event type", 256),
      id: string(projected.id, "projected event id", 256),
      seq: projected.seq,
      aggregateID: string(projected.aggregateID, "projected event aggregate", 256),
      data: record(projected.data, "projected event data"),
    }
    if (!isGlobalPayload(normalized)) fail("projected event", "has an invalid envelope")
    return normalized
  }
  if (!isGlobalPayload(source)) fail("global event payload", "has an invalid envelope")
  return source
}

export function decodeTuiGlobalEvent(value: unknown): GlobalEvent {
  const source = record(value, "global event")
  const directory =
    source.directory === undefined ? "global" : string(source.directory, "event directory", MAX_DIRECTORY_CHARACTERS)
  const project = optionalString(source.project, "event project", MAX_DIRECTORY_CHARACTERS)
  const payload = globalPayload(source.payload)
  return project === undefined ? { directory, payload } : { directory, project, payload }
}

function livePids(value: unknown) {
  const source = record(value, "subsystem inventory")
  if (!Array.isArray(source.pids) || source.pids.length > MAX_RESOURCE_COUNT) {
    fail("subsystem pids", `must be an array with at most ${MAX_RESOURCE_COUNT} entries`)
  }
  const pids = source.pids.map((pid) => {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      fail("subsystem pid", "must be a positive integer")
    }
    return pid
  })
  return { pids }
}

function dockerResource(value: unknown): DockerResource {
  const source = record(value, "Docker resource")
  const name = string(source.name, "Docker resource name", MAX_RESOURCE_NAME_CHARACTERS)
  if (source.action !== "remove" && source.action !== "stop") {
    fail("Docker resource action", "must be remove or stop")
  }
  if (source.kind !== "expert" && source.kind !== "zap" && source.kind !== "dependency") {
    fail("Docker resource kind", "must be expert, zap, or dependency")
  }
  return { name, action: source.action, kind: source.kind }
}

function liveDockerResources(value: unknown) {
  const source = record(value, "Docker inventory")
  if (!Array.isArray(source.resources) || source.resources.length > MAX_RESOURCE_COUNT) {
    fail("Docker resources", `must be an array with at most ${MAX_RESOURCE_COUNT} entries`)
  }
  return { resources: source.resources.map(dockerResource) }
}

export const TuiRpcContract = Rpc.contract({
  methods: {
    fetch: { input: fetchInput, result: fetchResult },
    snapshot: { input: voidValue, result: snapshotResult },
    server: { input: serverInput, result: serverResult },
    reload: { input: voidValue, result: voidValue },
    shutdown: { input: voidValue, result: voidValue },
  },
  events: {
    "global.event": decodeTuiGlobalEvent,
    "subsystem.live": livePids,
    "docker.live": liveDockerResources,
  },
})
