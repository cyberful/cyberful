// ── Code Graph Search And Summary Algorithms ────────────────────────────────
// Implements deterministic identifiers, dependency invalidation, SCC
// condensation, DAG function summaries, bounded weighted path search,
// taint traversal, and forward/backward slicing over persisted graph records.
// Every public search is capped and reports truncation instead of exhausting
// host memory on adversarial or highly connected repositories.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import type {
  FileCoverage,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphPath,
  GraphQuery,
  GraphQueryResult,
} from "./types"
import type { StoredSummary } from "./store"

export function stableIdentifier(namespace: string, ...values: readonly string[]) {
  const digest = createHash("sha256")
  digest.update(namespace).update("\0")
  values.forEach((value) => digest.update(value).update("\0"))
  return digest.digest("hex")
}

export function reverseDependencyClosure(seedFiles: readonly string[], edges: readonly GraphEdge[]) {
  const reverse = new Map<string, Set<string>>()
  edges.forEach((edge) => {
    if (edge.sourceFile === edge.targetFile) return
    reverse.set(edge.targetFile, (reverse.get(edge.targetFile) ?? new Set()).add(edge.sourceFile))
  })
  const closure = new Set(seedFiles)
  const queue = [...seedFiles]
  while (queue.length > 0) {
    const target = queue.shift()
    if (!target) continue
    for (const dependent of reverse.get(target) ?? []) {
      if (closure.has(dependent)) continue
      closure.add(dependent)
      queue.push(dependent)
    }
  }
  return [...closure].toSorted()
}

// ── Recursive Call Cycles Become One Summary Unit ──────────────────────────
// Direct and mutual recursion make a per-function topological order impossible.
// Iterative two-pass condensation identifies the exact recursive units without
// consuming the JavaScript call stack on repository-sized call chains. The SCC
// DAG can then propagate effects once without special-casing self calls or
// depending on source discovery order.
// ─────────────────────────────────────────────────────────────────────────────

export function stronglyConnectedComponents(nodeIds: readonly string[], edges: readonly GraphEdge[]) {
  const allowed = new Set(nodeIds)
  const adjacency = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  edges
    .filter((edge) => edge.kind === "call" && allowed.has(edge.source) && allowed.has(edge.target))
    .forEach((edge) => {
      const targets = adjacency.get(edge.source) ?? []
      targets.push(edge.target)
      adjacency.set(edge.source, targets)
      const sources = reverse.get(edge.target) ?? []
      sources.push(edge.source)
      reverse.set(edge.target, sources)
    })
  adjacency.forEach((targets, node) => adjacency.set(node, targets.toSorted()))
  reverse.forEach((sources, node) => reverse.set(node, sources.toSorted()))

  const visited = new Set<string>()
  const finishOrder: string[] = []
  for (const root of nodeIds.toSorted()) {
    if (visited.has(root)) continue
    visited.add(root)
    const stack: { readonly node: string; nextTarget: number }[] = [{ node: root, nextTarget: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (!frame) break
      const targets = adjacency.get(frame.node) ?? []
      const target = targets[frame.nextTarget]
      if (target !== undefined) {
        frame.nextTarget += 1
        if (visited.has(target)) continue
        visited.add(target)
        stack.push({ node: target, nextTarget: 0 })
        continue
      }
      stack.pop()
      finishOrder.push(frame.node)
    }
  }

  const assigned = new Set<string>()
  const components: string[][] = []
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const root = finishOrder[index]
    if (!root || assigned.has(root)) continue
    assigned.add(root)
    const component: string[] = []
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node) break
      component.push(node)
      const sources = reverse.get(node) ?? []
      for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
        const source = sources[sourceIndex]
        if (!source || assigned.has(source)) continue
        assigned.add(source)
        stack.push(source)
      }
    }
    components.push(component.toSorted())
  }
  return components.toSorted((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""))
}

const callableKinds = new Set<GraphNode["kind"]>(["function", "method", "constructor", "block"])

interface MutableSummary {
  readonly nodeId: string
  readonly reads: Set<string>
  readonly writes: Set<string>
  readonly sources: Set<string>
  readonly sinks: Set<string>
  readonly guards: Set<string>
  readonly callees: Set<string>
}

function ownerMap(nodes: readonly GraphNode[], edges: readonly GraphEdge[]) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const parent = new Map(
    edges.filter((edge) => edge.kind === "contains").map((edge) => [edge.target, edge.source] as const),
  )
  const owners = new Map<string, string>()
  nodes.forEach((node) => {
    let cursor: string | undefined = node.id
    const visited = new Set<string>()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const candidate = nodeMap.get(cursor)
      if (candidate && callableKinds.has(candidate.kind)) {
        owners.set(node.id, candidate.id)
        return
      }
      cursor = parent.get(cursor)
    }
  })
  return owners
}

function unionInto(target: Set<string>, source: ReadonlySet<string>) {
  source.forEach((value) => target.add(value))
}

export const FUNCTION_SUMMARY_ALGORITHM_VERSION = 2 as const

export interface FunctionSummaryBuildMetrics {
  readonly algorithmVersion: typeof FUNCTION_SUMMARY_ALGORITHM_VERSION
  readonly callableNodes: number
  readonly normalizedCallEdges: number
  readonly components: number
  readonly componentEdges: number
  readonly propagatedComponentEdges: number
}

interface ComponentSummary {
  readonly id: number
  readonly members: readonly string[]
  readonly reads: Set<string>
  readonly writes: Set<string>
  readonly sources: Set<string>
  readonly sinks: Set<string>
  readonly guards: Set<string>
  readonly dependencies: Set<number>
  readonly callers: Set<number>
}

function materializeSummary(summary: MutableSummary): StoredSummary {
  const reads = [...summary.reads].toSorted()
  const writes = [...summary.writes].toSorted()
  const sources = [...summary.sources].toSorted()
  const sinks = [...summary.sinks].toSorted()
  const guards = [...summary.guards].toSorted()
  const callees = [...summary.callees].toSorted()
  return {
    nodeId: summary.nodeId,
    reads,
    writes,
    sources,
    sinks,
    guards,
    callees,
    fingerprint: stableIdentifier(
      "summary",
      summary.nodeId,
      ...reads,
      ...writes,
      ...sources,
      ...sinks,
      ...guards,
      ...callees,
    ),
  }
}

// ── Interprocedural Effects Flow Once Across The SCC DAG ──────────────────
// Call references originate on body statements, so the owner-normalized call
// relation—not raw statement-to-function edges—defines recursion. Each SCC
// aggregates its local effects, then finished callee components propagate once
// to their callers. This is linear in the normalized call graph rather than a
// repository-wide fixed point. `callees` intentionally remains direct: storing
// every transitive callee for every function would make a simple chain itself
// quadratic; callers can traverse the persisted call graph when they need it.
// ─────────────────────────────────────────────────────────────────────────────

export function buildFunctionSummariesWithMetrics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): { readonly summaries: readonly StoredSummary[]; readonly metrics: FunctionSummaryBuildMetrics } {
  const owners = ownerMap(nodes, edges)
  const summaries = new Map<string, MutableSummary>()
  nodes
    .filter((node) => callableKinds.has(node.kind))
    .forEach((node) =>
      summaries.set(node.id, {
        nodeId: node.id,
        reads: new Set(),
        writes: new Set(),
        sources: new Set(),
        sinks: new Set(),
        guards: new Set(),
        callees: new Set(),
      }),
    )

  nodes.forEach((node) => {
    const owner = owners.get(node.id)
    const summary = owner ? summaries.get(owner) : undefined
    if (!summary) return
    if (node.tags.includes("source")) summary.sources.add(node.id)
    if (node.tags.includes("sink")) summary.sinks.add(node.id)
    if (node.tags.includes("guard") || node.tags.includes("sanitizer")) summary.guards.add(node.id)
  })

  edges.forEach((edge) => {
    const sourceOwner = owners.get(edge.source)
    const targetOwner = owners.get(edge.target)
    if (edge.kind === "data" && edge.evidence) {
      if (targetOwner) summaries.get(targetOwner)?.reads.add(edge.evidence)
      if (sourceOwner) summaries.get(sourceOwner)?.writes.add(edge.evidence)
    }
    if (edge.kind === "call" && sourceOwner && targetOwner) summaries.get(sourceOwner)?.callees.add(targetOwner)
  })

  const normalizedCallEdges: GraphEdge[] = []
  for (const summary of summaries.values()) {
    for (const callee of summary.callees) {
      normalizedCallEdges.push({
        id: stableIdentifier("summary-call", summary.nodeId, callee),
        source: summary.nodeId,
        target: callee,
        sourceFile: "",
        targetFile: "",
        kind: "call",
        weight: 1,
        interprocedural: true,
      })
    }
  }

  const componentByNode = new Map<string, number>()
  const components: ComponentSummary[] = stronglyConnectedComponents([...summaries.keys()], normalizedCallEdges).map(
    (members, id) => {
      members.forEach((nodeId) => componentByNode.set(nodeId, id))
      return {
        id,
        members,
        reads: new Set(),
        writes: new Set(),
        sources: new Set(),
        sinks: new Set(),
        guards: new Set(),
        dependencies: new Set(),
        callers: new Set(),
      }
    },
  )

  components.forEach((component) => {
    component.members.forEach((member) => {
      const summary = summaries.get(member)
      if (!summary) return
      unionInto(component.reads, summary.reads)
      unionInto(component.writes, summary.writes)
      unionInto(component.sources, summary.sources)
      unionInto(component.sinks, summary.sinks)
      unionInto(component.guards, summary.guards)
      summary.callees.forEach((callee) => {
        const dependency = componentByNode.get(callee)
        if (dependency !== undefined && dependency !== component.id) component.dependencies.add(dependency)
      })
    })
  })
  components.forEach((component) =>
    component.dependencies.forEach((dependency) => components[dependency]?.callers.add(component.id)),
  )

  const remainingDependencies = components.map((component) => component.dependencies.size)
  const ready = components.filter((component) => component.dependencies.size === 0).map((component) => component.id)
  let propagatedComponentEdges = 0
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const completed = components[ready[cursor] ?? -1]
    if (!completed) continue
    completed.callers.forEach((callerId) => {
      const caller = components[callerId]
      if (!caller) return
      unionInto(caller.reads, completed.reads)
      unionInto(caller.writes, completed.writes)
      unionInto(caller.sources, completed.sources)
      unionInto(caller.sinks, completed.sinks)
      unionInto(caller.guards, completed.guards)
      propagatedComponentEdges += 1
      remainingDependencies[callerId] = (remainingDependencies[callerId] ?? 1) - 1
      if (remainingDependencies[callerId] === 0) ready.push(callerId)
    })
  }

  components.forEach((component) =>
    component.members.forEach((member) => {
      const summary = summaries.get(member)
      if (!summary) return
      unionInto(summary.reads, component.reads)
      unionInto(summary.writes, component.writes)
      unionInto(summary.sources, component.sources)
      unionInto(summary.sinks, component.sinks)
      unionInto(summary.guards, component.guards)
    }),
  )

  const result = [...summaries.values()]
    .map(materializeSummary)
    .toSorted((left, right) => left.nodeId.localeCompare(right.nodeId))
  const componentEdges = components.reduce((total, component) => total + component.dependencies.size, 0)
  return {
    summaries: result,
    metrics: {
      algorithmVersion: FUNCTION_SUMMARY_ALGORITHM_VERSION,
      callableNodes: summaries.size,
      normalizedCallEdges: normalizedCallEdges.length,
      components: components.length,
      componentEdges,
      propagatedComponentEdges,
    },
  }
}

export function buildFunctionSummaries(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): StoredSummary[] {
  return [...buildFunctionSummariesWithMetrics(nodes, edges).summaries]
}

interface SearchState {
  readonly node: string
  readonly nodes: readonly string[]
  readonly edges: readonly string[]
  readonly weight: number
  readonly depth: number
  readonly order: number
}

class SearchStateHeap {
  readonly #values: SearchState[] = []

  get size() {
    return this.#values.length
  }

  push(value: SearchState) {
    this.#values.push(value)
    let index = this.#values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      const parentValue = this.#values[parent]
      if (!parentValue || compareSearchState(parentValue, value) <= 0) break
      this.#values[index] = parentValue
      index = parent
    }
    this.#values[index] = value
  }

  pop() {
    const first = this.#values[0]
    const last = this.#values.pop()
    if (!first || !last || this.#values.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.#values.length) break
      const leftValue = this.#values[left]
      const rightValue = this.#values[right]
      if (!leftValue) break
      const child = rightValue && compareSearchState(rightValue, leftValue) < 0 ? right : left
      const childValue = this.#values[child]
      if (!childValue || compareSearchState(last, childValue) <= 0) break
      this.#values[index] = childValue
      index = child
    }
    this.#values[index] = last
    return first
  }
}

function compareSearchState(left: SearchState, right: SearchState) {
  return left.weight - right.weight || left.depth - right.depth || left.order - right.order
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || !Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

function adjacencyFor(
  edges: readonly GraphEdge[],
  direction: "forward" | "backward" | "both",
  kinds?: readonly GraphEdgeKind[],
) {
  const allowed = kinds ? new Set(kinds) : undefined
  const adjacency = new Map<string, { readonly edge: GraphEdge; readonly target: string }[]>()
  edges.forEach((edge) => {
    if (allowed && !allowed.has(edge.kind)) return
    if (direction === "forward" || direction === "both") {
      const candidates = adjacency.get(edge.source) ?? []
      candidates.push({ edge, target: edge.target })
      adjacency.set(edge.source, candidates)
    }
    if (direction === "backward" || direction === "both") {
      const candidates = adjacency.get(edge.target) ?? []
      candidates.push({ edge, target: edge.source })
      adjacency.set(edge.target, candidates)
    }
  })
  adjacency.forEach((candidates) =>
    candidates.sort(
      (left, right) =>
        left.edge.weight - right.edge.weight ||
        left.target.localeCompare(right.target) ||
        left.edge.id.localeCompare(right.edge.id),
    ),
  )
  return adjacency
}

function pathFromState(state: SearchState): GraphPath {
  return { nodes: state.nodes, edges: state.edges, weight: state.weight }
}

// ── Search Bounds Are Part Of The Security Boundary ────────────────────────
// Repository content controls graph fan-out, cycles, and edge weights. Search
// requests are therefore clamped independently of caller input and traversal
// tracks the best observed depth/weight per node. A hard state budget prevents
// path enumeration from becoming a denial of service; `truncated` tells the
// caller that the returned subgraph is evidence, not proof of exhaustion.
// ─────────────────────────────────────────────────────────────────────────────

export const WEIGHTED_PATH_ALGORITHM_VERSION = 2 as const
export const WEIGHTED_PATH_STATE_BUDGET = 50_000

function weightedPaths(input: {
  readonly starts: readonly string[]
  readonly targets: ReadonlySet<string>
  readonly edges: readonly GraphEdge[]
  readonly kinds?: readonly GraphEdgeKind[]
  readonly maxDepth: number
  readonly maxPaths: number
}) {
  const adjacency = adjacencyFor(input.edges, "forward", input.kinds)
  const pending = new SearchStateHeap()
  let nextOrder = 0
  input.starts
    .toSorted()
    .forEach((node) => pending.push({ node, nodes: [node], edges: [], weight: 0, depth: 0, order: nextOrder++ }))
  const frontiers = new Map(input.starts.map((node) => [node, [{ depth: 0, weight: 0 }]]))
  const paths: GraphPath[] = []
  let visitedStates = 0
  while (pending.size > 0 && paths.length < input.maxPaths && visitedStates < WEIGHTED_PATH_STATE_BUDGET) {
    const state = pending.pop()
    if (!state) break
    visitedStates += 1
    if (input.targets.has(state.node) && state.depth > 0) {
      paths.push(pathFromState(state))
      continue
    }
    if (state.depth >= input.maxDepth) continue
    for (const candidate of adjacency.get(state.node) ?? []) {
      if (state.nodes.includes(candidate.target)) continue
      const nextWeight = state.weight + candidate.edge.weight
      const nextDepth = state.depth + 1
      const frontier = frontiers.get(candidate.target) ?? []
      if (frontier.some((point) => point.depth <= nextDepth && point.weight <= nextWeight)) continue
      frontiers.set(candidate.target, [
        ...frontier.filter((point) => !(nextDepth <= point.depth && nextWeight <= point.weight)),
        { depth: nextDepth, weight: nextWeight },
      ])
      pending.push({
        node: candidate.target,
        nodes: [...state.nodes, candidate.target],
        edges: [...state.edges, candidate.edge.id],
        weight: nextWeight,
        depth: nextDepth,
        order: nextOrder++,
      })
    }
  }
  return { paths, truncated: pending.size > 0 || visitedStates >= WEIGHTED_PATH_STATE_BUDGET }
}

function collectForPaths(
  paths: readonly GraphPath[],
  nodeMap: ReadonlyMap<string, GraphNode>,
  edgeMap: ReadonlyMap<string, GraphEdge>,
) {
  const nodeIds = new Set(paths.flatMap((path) => path.nodes))
  const edgeIds = new Set(paths.flatMap((path) => path.edges))
  return {
    nodes: [...nodeIds].flatMap((id) => {
      const node = nodeMap.get(id)
      return node ? [node] : []
    }),
    edges: [...edgeIds].flatMap((id) => {
      const edge = edgeMap.get(id)
      return edge ? [edge] : []
    }),
  }
}

export function queryGraph(
  query: GraphQuery,
  graph: {
    readonly nodes: readonly GraphNode[]
    readonly edges: readonly GraphEdge[]
    readonly coverage: readonly FileCoverage[]
  },
): GraphQueryResult {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]))
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const empty = { nodes: [], edges: [], paths: [], coverage: [], truncated: false } satisfies GraphQueryResult

  if (query.kind === "coverage") return { ...empty, coverage: graph.coverage }

  if (query.kind === "symbols") {
    const limit = bounded(query.limit, 50, 1, 1_000)
    const name = query.name?.toLowerCase()
    const matches = graph.nodes.filter(
      (node) =>
        (!name || node.name.toLowerCase().includes(name)) &&
        (!query.file || node.file === query.file) &&
        (!query.nodeKind || node.kind === query.nodeKind),
    )
    return { ...empty, nodes: matches.slice(0, limit), truncated: matches.length > limit }
  }

  if (query.kind === "path") {
    if (!nodeMap.has(query.fromNodeId) || !nodeMap.has(query.toNodeId)) return empty
    const search = weightedPaths({
      starts: [query.fromNodeId],
      targets: new Set([query.toNodeId]),
      edges: graph.edges,
      kinds: query.edgeKinds,
      maxDepth: bounded(query.maxDepth, 12, 1, 40),
      maxPaths: 1,
    })
    const selected = collectForPaths(search.paths, nodeMap, edgeMap)
    return { ...selected, paths: search.paths, coverage: [], truncated: search.truncated }
  }

  if (query.kind === "taint") {
    const sources = query.sourceNodeIds?.length
      ? query.sourceNodeIds.filter((id) => nodeMap.has(id)).slice(0, 500)
      : graph.nodes.filter((node) => node.tags.includes("source")).map((node) => node.id)
    const sinks = new Set(
      query.sinkNodeIds?.length
        ? query.sinkNodeIds.filter((id) => nodeMap.has(id)).slice(0, 500)
        : graph.nodes.filter((node) => node.tags.includes("sink")).map((node) => node.id),
    )
    const search = weightedPaths({
      starts: sources,
      targets: sinks,
      edges: graph.edges,
      kinds: ["data", "call", "alias", "ffi", "abi", "trust-crossing", "control"],
      maxDepth: bounded(query.maxDepth, 18, 1, 50),
      maxPaths: bounded(query.maxPaths, 20, 1, 100),
    })
    const selected = collectForPaths(search.paths, nodeMap, edgeMap)
    return { ...selected, paths: search.paths, coverage: [], truncated: search.truncated }
  }

  const direction = query.kind === "neighbors" ? (query.direction ?? "both") : (query.direction ?? "backward")
  const maxDepth = bounded(query.maxDepth, query.kind === "slice" ? 12 : 3, 1, 40)
  const limit = bounded(query.limit, 200, 1, 2_000)
  const adjacency = adjacencyFor(graph.edges, direction, query.edgeKinds)
  const visited = new Set([query.nodeId])
  const selectedEdges = new Map<string, GraphEdge>()
  const queue = [{ node: query.nodeId, depth: 0 }]
  while (queue.length > 0 && visited.size < limit) {
    const current = queue.shift()
    if (!current || current.depth >= maxDepth) continue
    for (const candidate of adjacency.get(current.node) ?? []) {
      selectedEdges.set(candidate.edge.id, candidate.edge)
      if (visited.has(candidate.target)) continue
      visited.add(candidate.target)
      queue.push({ node: candidate.target, depth: current.depth + 1 })
      if (visited.size >= limit) break
    }
  }
  return {
    nodes: [...visited].flatMap((id) => {
      const node = nodeMap.get(id)
      return node ? [node] : []
    }),
    edges: [...selectedEdges.values()],
    paths: [],
    coverage: [],
    truncated: queue.length > 0 || visited.size >= limit,
  }
}
