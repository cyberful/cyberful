// ── Code Graph Algorithm Tests ──────────────────────────────────────────────
// Protects weighted path choice, bounded slicing, dependency closure, recursive
// call condensation, and interprocedural summary propagation with small graphs
// whose expected behavior is observable without storage or language parsing.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  buildFunctionSummaries,
  buildFunctionSummariesWithMetrics,
  queryGraph,
  reverseDependencyClosure,
  stronglyConnectedComponents,
  WEIGHTED_PATH_STATE_BUDGET,
} from "./algorithms"
import type { GraphEdge, GraphNode } from "./types"

function node(id: string, input: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    file: input.file ?? `${id}.ts`,
    language: "typescript",
    kind: input.kind ?? "function",
    name: input.name ?? id,
    line: input.line ?? 1,
    column: input.column ?? 1,
    endLine: input.endLine ?? 1,
    tags: input.tags ?? [],
    attributes: input.attributes ?? {},
  }
}

function edge(id: string, source: GraphNode, target: GraphNode, input: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id,
    source: source.id,
    target: target.id,
    sourceFile: source.file,
    targetFile: target.file,
    kind: input.kind ?? "call",
    weight: input.weight ?? 1,
    evidence: input.evidence,
    interprocedural: input.interprocedural ?? source.file !== target.file,
  }
}

describe("bounded graph search", () => {
  test("chooses the lowest-weight bounded path and slices in reverse", () => {
    const a = node("a")
    const b = node("b")
    const c = node("c")
    const edges = [
      edge("direct", a, b, { kind: "data", weight: 10 }),
      edge("first", a, c, { kind: "data", weight: 1 }),
      edge("second", c, b, { kind: "data", weight: 1 }),
    ]
    const graph = { nodes: [a, b, c], edges, coverage: [] }
    const path = queryGraph({ kind: "path", fromNodeId: "a", toNodeId: "b", maxDepth: 3 }, graph)
    expect(path.paths).toEqual([{ nodes: ["a", "c", "b"], edges: ["first", "second"], weight: 2 }])
    const slice = queryGraph({ kind: "slice", nodeId: "b", direction: "backward", maxDepth: 2 }, graph)
    expect(new Set(slice.nodes.map((item) => item.id))).toEqual(new Set(["a", "b", "c"]))
  })

  test("retains a costlier shallow arrival when the cheap arrival exhausts depth", () => {
    const s = node("s")
    const a = node("a")
    const b = node("b")
    const c = node("c")
    const x = node("x")
    const t = node("t")
    const graph = {
      nodes: [s, a, b, c, x, t],
      edges: [
        edge("s-a", s, a, { kind: "data", weight: 1 }),
        edge("a-c", a, c, { kind: "data", weight: 1 }),
        edge("c-x", c, x, { kind: "data", weight: 1 }),
        edge("s-b", s, b, { kind: "data", weight: 10 }),
        edge("b-x", b, x, { kind: "data", weight: 1 }),
        edge("x-t", x, t, { kind: "data", weight: 1 }),
      ],
      coverage: [],
    }
    const result = queryGraph({ kind: "path", fromNodeId: s.id, toNodeId: t.id, maxDepth: 3 }, graph)
    expect(result.paths).toEqual([{ nodes: ["s", "b", "x", "t"], edges: ["s-b", "b-x", "x-t"], weight: 12 }])
    expect(result.truncated).toBe(false)
  })

  test("propagates invalidation through reverse callers", () => {
    const leaf = node("leaf", { file: "leaf.ts" })
    const middle = node("middle", { file: "middle.ts" })
    const entry = node("entry", { file: "entry.ts" })
    expect(reverseDependencyClosure(["leaf.ts"], [edge("m-l", middle, leaf), edge("e-m", entry, middle)])).toEqual([
      "entry.ts",
      "leaf.ts",
      "middle.ts",
    ])
  })

  test("enforces the versioned state budget on a high-fanout graph", () => {
    const source = node("source")
    const target = node("isolated-target")
    const fanout = Array.from({ length: WEIGHTED_PATH_STATE_BUDGET + 1 }, (_, index) =>
      node(`branch-${String(index).padStart(5, "0")}`),
    )
    const edges = fanout.map((branch, index) => edge(`fanout-${index}`, source, branch, { kind: "data" }))
    const result = queryGraph(
      { kind: "path", fromNodeId: source.id, toNodeId: target.id, maxDepth: 2 },
      { nodes: [source, target, ...fanout], edges, coverage: [] },
    )
    expect(result.paths).toEqual([])
    expect(result.truncated).toBe(true)
  })
})

describe("interprocedural summaries", () => {
  test("condenses recursive calls and propagates tagged sink effects", () => {
    const first = node("first")
    const second = node("second")
    const sink = node("sink", { file: second.file, kind: "statement", tags: ["sink"] })
    const firstCallSite = node("first-call-site", { file: first.file, kind: "statement" })
    const secondCallSite = node("second-call-site", { file: second.file, kind: "statement" })
    const edges = [
      edge("first-contains", first, firstCallSite, { kind: "contains", interprocedural: false }),
      edge("second-call-contains", second, secondCallSite, { kind: "contains", interprocedural: false }),
      edge("second-contains", second, sink, { kind: "contains", interprocedural: false }),
      edge("first-second", firstCallSite, second),
      edge("second-first", secondCallSite, first),
    ]
    expect(stronglyConnectedComponents([first.id, second.id], edges)).toEqual([["first"], ["second"]])
    const summaries = buildFunctionSummaries([first, second, sink, firstCallSite, secondCallSite], edges)
    expect(summaries.find((summary) => summary.nodeId === first.id)?.sinks).toContain(sink.id)
    expect(summaries.find((summary) => summary.nodeId === first.id)?.callees).toContain(second.id)
    expect(summaries.find((summary) => summary.nodeId === second.id)?.sources).toEqual([])
  })

  test("keeps summary propagation linear in a long owner-normalized call chain", () => {
    const functions = Array.from({ length: 10_000 }, (_, index) => node(`f${String(index).padStart(5, "0")}`))
    const calls = functions.slice(1).flatMap((target, index) => {
      const source = functions[index]
      return source ? [edge(`c${index}`, source, target)] : []
    })
    const { summaries, metrics } = buildFunctionSummariesWithMetrics(functions, calls)
    expect(metrics).toEqual({
      algorithmVersion: 2,
      callableNodes: 10_000,
      normalizedCallEdges: 9_999,
      components: 10_000,
      componentEdges: 9_999,
      propagatedComponentEdges: 9_999,
    })
    expect(summaries).toHaveLength(10_000)
    expect(Math.max(...summaries.map((summary) => summary.callees.length))).toBe(1)
  })

  test("condenses a repository-sized call chain without recursive stack growth", () => {
    const ids = Array.from({ length: 100_000 }, (_, index) => `n${String(index).padStart(6, "0")}`)
    const edges = ids.slice(1).map(
      (target, index): GraphEdge => ({
        id: `e${index}`,
        source: ids[index] ?? "",
        target,
        sourceFile: "chain.ts",
        targetFile: "chain.ts",
        kind: "call",
        weight: 1,
        interprocedural: false,
      }),
    )
    const components = stronglyConnectedComponents(ids, edges)
    expect(components).toHaveLength(100_000)
    expect(components[0]).toEqual(["n000000"])
    expect(components.at(-1)).toEqual(["n099999"])
  })
})
