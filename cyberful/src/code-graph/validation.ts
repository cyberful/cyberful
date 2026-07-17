// ── Code Graph Gateway Validation ───────────────────────────────────────────
// Converts unknown gateway payloads into the deliberately small indexing and
// query unions consumed by the engine. Paths, enum values, collection sizes,
// depths, and result limits are rejected or clamped before they can influence
// filesystem access or graph traversal cost.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import {
  graphEdgeKinds,
  graphNodeKinds,
  type GraphEdgeKind,
  type GraphNodeKind,
  type GraphQuery,
  type IndexOptions,
} from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  return value
}

function text(value: unknown, label: string, maximum = 4_096) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters.`)
  return normalized
}

function optionalInteger(value: unknown, label: string, maximum: number) {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`)
  return value
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = typeof value === "string" ? values.find((candidate) => candidate === value) : undefined
  if (match === undefined) throw new Error(`${label} has an unsupported value.`)
  return match
}

function optionalOneOf<T extends string>(value: unknown, values: readonly T[], label: string) {
  return value === undefined ? undefined : oneOf(value, values, label)
}

function optionalEdges(value: unknown, label: string): readonly GraphEdgeKind[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > graphEdgeKinds.length)
    throw new Error(`${label} must be a bounded array.`)
  return value.map((item) => oneOf(item, graphEdgeKinds, label))
}

function optionalIds(value: unknown, label: string) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label} must contain at most 500 node ids.`)
  return value.map((item, index) => text(item, `${label}[${index}]`, 128))
}

function relativePath(value: unknown, label: string) {
  const normalized = text(value, label).replaceAll("\\", "/").replace(/^\.\//, "")
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes(".."))
    throw new Error(`${label} must stay relative to the source root.`)
  return normalized
}

export function parseIndexOptions(value: unknown): IndexOptions {
  if (value === undefined) return {}
  const input = object(value, "code graph index options")
  if (input.force !== undefined && typeof input.force !== "boolean")
    throw new Error("code graph index force must be boolean.")
  const paths = input.paths
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > 10_000))
    throw new Error("code graph index paths must contain at most 10000 relative paths.")
  return {
    paths: paths?.map((item, index) => relativePath(item, `code graph index paths[${index}]`)),
    force: input.force,
    snapshotLabel: input.snapshotLabel === undefined ? undefined : text(input.snapshotLabel, "snapshotLabel", 200),
  }
}

export function parseGraphQuery(value: unknown): GraphQuery {
  const input = object(value, "code graph query")
  const kind = oneOf(
    input.kind,
    ["symbols", "neighbors", "path", "taint", "slice", "coverage"] as const,
    "code graph query kind",
  )
  if (kind === "coverage") return { kind }
  if (kind === "symbols") {
    return {
      kind,
      name: input.name === undefined ? undefined : text(input.name, "symbols.name", 300),
      file: input.file === undefined ? undefined : relativePath(input.file, "symbols.file"),
      nodeKind: optionalOneOf<GraphNodeKind>(input.nodeKind, graphNodeKinds, "symbols.nodeKind"),
      limit: optionalInteger(input.limit, "symbols.limit", 1_000),
    }
  }
  if (kind === "path") {
    return {
      kind,
      fromNodeId: text(input.fromNodeId, "path.fromNodeId", 128),
      toNodeId: text(input.toNodeId, "path.toNodeId", 128),
      edgeKinds: optionalEdges(input.edgeKinds, "path.edgeKinds"),
      maxDepth: optionalInteger(input.maxDepth, "path.maxDepth", 40),
    }
  }
  if (kind === "taint") {
    return {
      kind,
      sourceNodeIds: optionalIds(input.sourceNodeIds, "taint.sourceNodeIds"),
      sinkNodeIds: optionalIds(input.sinkNodeIds, "taint.sinkNodeIds"),
      maxDepth: optionalInteger(input.maxDepth, "taint.maxDepth", 50),
      maxPaths: optionalInteger(input.maxPaths, "taint.maxPaths", 100),
    }
  }
  if (kind === "neighbors") {
    return {
      kind,
      nodeId: text(input.nodeId, "neighbors.nodeId", 128),
      direction: optionalOneOf(input.direction, ["forward", "backward", "both"] as const, "neighbors.direction"),
      edgeKinds: optionalEdges(input.edgeKinds, "neighbors.edgeKinds"),
      maxDepth: optionalInteger(input.maxDepth, "neighbors.maxDepth", 40),
      limit: optionalInteger(input.limit, "neighbors.limit", 2_000),
    }
  }
  return {
    kind,
    nodeId: text(input.nodeId, "slice.nodeId", 128),
    direction: optionalOneOf(input.direction, ["forward", "backward"] as const, "slice.direction"),
    edgeKinds: optionalEdges(input.edgeKinds, "slice.edgeKinds"),
    maxDepth: optionalInteger(input.maxDepth, "slice.maxDepth", 40),
    limit: optionalInteger(input.limit, "slice.limit", 2_000),
  }
}
