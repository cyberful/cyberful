// ── Incremental Code Graph Engine ───────────────────────────────────────────
// Inventories a contained source root, classifies and analyzes bounded files,
// invalidates changed files plus reverse dependents, and atomically commits a
// reusable graph snapshot. One serialized write owner prevents overlapping
// phase/tool calls from interleaving graph mutations or summary recomputation.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { realpathSync } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { buildFunctionSummaries, queryGraph, reverseDependencyClosure, stableIdentifier } from "./algorithms"
import {
  adapterAnalysisFingerprint,
  createDefaultLanguageRegistry,
  LanguageRegistry,
  type LanguageDetection,
} from "./registry"
import {
  CodeGraphStore,
  REFERENCE_RESOLUTION_ALGORITHM_VERSION,
  type GraphSummarizer,
  type StoredFileState,
  type StoredReference,
} from "./store"
import type {
  AdapterAnalysis,
  FileCoverage,
  GraphEdge,
  GraphNode,
  GraphQuery,
  GraphQueryResult,
  IndexOptions,
  IndexReport,
  LanguageAdapter,
} from "./types"

interface Candidate {
  readonly path: string
  readonly size: number
  readonly contentHash: string
  readonly content?: string
  readonly adapter?: LanguageAdapter
  readonly coverage: FileCoverage
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export interface CodeGraphEngineOptions {
  readonly sourceRoot: string
  readonly store: CodeGraphStore
  readonly registry?: LanguageRegistry
  readonly excludedRoots?: readonly string[]
  readonly maxFileBytes?: number
  readonly maxFiles?: number
  readonly maxGraphRecords?: number
  readonly readConcurrency?: number
  readonly now?: () => Date
  readonly summarize?: GraphSummarizer
  readonly onProgress?: (progress: CodeGraphIndexProgress) => void | Promise<void>
}

export type CodeGraphIndexStage = "inventory" | "read" | "analyze" | "commit" | "complete" | "failed"

export interface CodeGraphIndexProgress {
  readonly stage: CodeGraphIndexStage
  readonly completed: number
  readonly total?: number
  readonly discovered?: number
  readonly indexed?: number
  readonly reused?: number
  readonly error?: string
}

export interface CodeGraphEngineLimits {
  readonly maxFileBytes: number
  readonly maxFiles: number
  readonly maxGraphRecords: number
  readonly readConcurrency: number
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string) {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return Math.min(maximum, Math.max(minimum, candidate))
}

export function normalizeCodeGraphEngineLimits(
  options: Pick<CodeGraphEngineOptions, "maxFileBytes" | "maxFiles" | "maxGraphRecords" | "readConcurrency">,
): CodeGraphEngineLimits {
  return {
    maxFileBytes: boundedInteger(options.maxFileBytes, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024, "maxFileBytes"),
    maxFiles: boundedInteger(options.maxFiles, 100_000, 1, 500_000, "maxFiles"),
    maxGraphRecords: boundedInteger(options.maxGraphRecords, 500_000, 1, 5_000_000, "maxGraphRecords"),
    readConcurrency: boundedInteger(options.readConcurrency, 8, 1, 32, "readConcurrency"),
  }
}

const excludedSegments = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".gradle",
  ".idea",
  ".next",
  ".pytest_cache",
  ".tox",
  ".venv",
  ".vscode",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
])

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalizeRelative(input: string) {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes(".."))
    throw new Error(`Source path must be relative and contained: ${input}`)
  return normalized
}

function excluded(relative: string) {
  return relative.split("/").some((segment) => excludedSegments.has(segment))
}

function binary(bytes: Uint8Array) {
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)
}

function bytesHash(bytes: Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

function unavailableCoverage(input: {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly status: FileCoverage["status"]
  readonly diagnostic: string
}): FileCoverage {
  const unsupported = { level: "unsupported", detail: "No semantic analysis was performed." } as const
  return {
    path: input.path,
    language: input.language,
    contentHash: input.contentHash,
    status: input.status,
    coverage: {
      parser: "unavailable",
      confidence: 0,
      capabilities: {
        parsing: unsupported,
        symbols: unsupported,
        controlFlow: unsupported,
        callGraph: unsupported,
        dataFlow: unsupported,
        aliasing: unsupported,
        summaries: unsupported,
        securitySemantics: unsupported,
        crossLanguage: unsupported,
      },
      limitations: [input.diagnostic],
    },
    diagnostics: [input.diagnostic],
  }
}

function analysisCoverage(input: {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly detection: LanguageDetection
  readonly analysis: AdapterAnalysis
}): FileCoverage {
  const ambiguity = input.detection.alternatives.filter((alternative) => alternative.score === input.detection.score)
  const diagnostics = [
    ...input.analysis.diagnostics,
    ...(ambiguity.length > 0
      ? [`Language detection tied with: ${ambiguity.map((alternative) => alternative.id).join(", ")}.`]
      : []),
  ]
  return {
    path: input.path,
    language: input.language,
    contentHash: input.contentHash,
    status: diagnostics.length > 0 ? "degraded" : "indexed",
    coverage: input.analysis.coverage,
    diagnostics,
  }
}

// ── Reuse Is Bound To Effective Adapter Semantics ─────────────────────────
// Identical source bytes do not imply an identical graph after an adapter or
// ruleset upgrade. Each file state therefore retains the adapter's declared
// version and implementation digest as one analysis fingerprint. Comparing it
// beside content invalidates only files owned by the changed adapter, while the
// snapshot fingerprint prevents downstream consumers from mistaking the new
// semantics for the prior graph.
// ─────────────────────────────────────────────────────────────────────────────

function stateFor(candidate: Candidate): StoredFileState {
  return {
    path: candidate.path,
    language: candidate.adapter?.id ?? candidate.coverage.language,
    contentHash: candidate.contentHash,
    analysisFingerprint: candidate.adapter
      ? adapterAnalysisFingerprint(candidate.adapter)
      : stableIdentifier("adapter-analysis", "unavailable", "1"),
    size: candidate.size,
  }
}

function chunks<T>(items: readonly T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

// ── File Bytes Are Contained And Bounded Before Analysis ───────────────────
// Source paths may originate in a model-facing gateway, and repositories may
// contain symlinks, binaries, generated blobs, or pathological single files.
// Each candidate is normalized, lstat'd, realpath-contained, size-capped, and
// binary-checked before decoding. Exclusions remain explicit coverage records
// so reports cannot confuse skipped input with successfully audited code.
// ─────────────────────────────────────────────────────────────────────────────

export class CodeGraphEngine {
  readonly #root: string
  readonly #store: CodeGraphStore
  readonly #registry: LanguageRegistry
  readonly #excludedRoots: readonly string[]
  readonly #maxFileBytes: number
  readonly #maxFiles: number
  readonly #maxGraphRecords: number
  readonly #readConcurrency: number
  readonly #now: () => Date
  readonly #summarize: GraphSummarizer
  readonly #onProgress?: (progress: CodeGraphIndexProgress) => void | Promise<void>
  #writeTail: Promise<void> = Promise.resolve()

  constructor(options: CodeGraphEngineOptions) {
    const limits = normalizeCodeGraphEngineLimits(options)
    this.#root = realpathSync(path.resolve(options.sourceRoot))
    this.#store = options.store
    this.#registry = options.registry ?? createDefaultLanguageRegistry()
    this.#excludedRoots = (options.excludedRoots ?? []).map((root) => path.resolve(root))
    this.#maxFileBytes = limits.maxFileBytes
    this.#maxFiles = limits.maxFiles
    this.#maxGraphRecords = limits.maxGraphRecords
    this.#readConcurrency = limits.readConcurrency
    this.#now = options.now ?? (() => new Date())
    this.#summarize = options.summarize ?? buildFunctionSummaries
    this.#onProgress = options.onProgress
  }

  async #progress(progress: CodeGraphIndexProgress) {
    await this.#onProgress?.(progress)
  }

  async #inventory(paths: readonly string[] | undefined, signal?: AbortSignal) {
    if (paths) return [...new Set(paths.map(normalizeRelative))].toSorted()
    const inventory: string[] = []
    const glob = new Bun.Glob("**/*")
    for await (const value of glob.scan({ cwd: this.#root, dot: true, onlyFiles: true, followSymlinks: false })) {
      if (signal?.aborted) throw new DOMException("Code graph indexing was aborted.", "AbortError")
      const relative = value.replaceAll("\\", "/")
      if (excluded(relative)) continue
      const absolute = path.resolve(this.#root, relative)
      if (this.#excludedRoots.some((root) => inside(root, absolute))) continue
      inventory.push(relative)
      if (inventory.length > this.#maxFiles)
        throw new Error(`Source inventory exceeds ${this.#maxFiles} files; provide a narrower paths selection.`)
      if (inventory.length % 1_000 === 0) await this.#progress({ stage: "inventory", completed: inventory.length })
    }
    return inventory.toSorted()
  }

  async #readCandidate(relative: string, signal?: AbortSignal): Promise<Candidate | undefined> {
    if (signal?.aborted) throw new DOMException("Code graph indexing was aborted.", "AbortError")
    const normalized = normalizeRelative(relative)
    if (excluded(normalized)) return
    const absolute = path.resolve(this.#root, normalized)
    if (!inside(this.#root, absolute) || this.#excludedRoots.some((root) => inside(root, absolute))) return
    let metadata
    try {
      metadata = await lstat(absolute)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) return
    const resolved = await realpath(absolute)
    if (!inside(this.#root, resolved) || this.#excludedRoots.some((root) => inside(root, resolved))) return

    const file = Bun.file(resolved)
    const prefix = await file.slice(0, Math.min(metadata.size, 65_536)).bytes()
    const prefixHash = bytesHash(prefix)
    const detection = this.#registry.detect({
      path: normalized,
      contentPrefix: new TextDecoder("utf-8", { fatal: false }).decode(prefix),
    })
    if (metadata.size > this.#maxFileBytes) {
      const contentHash = stableIdentifier("excluded-file", prefixHash, String(metadata.size))
      return {
        path: normalized,
        size: metadata.size,
        contentHash,
        adapter: detection?.adapter,
        coverage: unavailableCoverage({
          path: normalized,
          language: detection?.adapter.id ?? "unsupported",
          contentHash,
          status: "excluded",
          diagnostic: `File exceeds the ${this.#maxFileBytes}-byte analysis limit.`,
        }),
      }
    }

    const bytes = metadata.size <= prefix.length ? prefix : await file.bytes()
    const contentHash = bytesHash(bytes)
    if (binary(bytes)) {
      return {
        path: normalized,
        size: metadata.size,
        contentHash,
        coverage: unavailableCoverage({
          path: normalized,
          language: detection?.adapter.id ?? "binary",
          contentHash,
          status: "unsupported",
          diagnostic: "Binary content is outside source graph analysis.",
        }),
      }
    }
    if (!detection) {
      return {
        path: normalized,
        size: metadata.size,
        contentHash,
        coverage: unavailableCoverage({
          path: normalized,
          language: "unsupported",
          contentHash,
          status: "unsupported",
          diagnostic: "No registered language adapter recognized this file.",
        }),
      }
    }

    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    return {
      path: normalized,
      size: metadata.size,
      contentHash,
      content,
      adapter: detection.adapter,
      coverage: {
        path: normalized,
        language: detection.adapter.id,
        contentHash,
        status: "indexed",
        coverage: {
          parser: detection.adapter.declarative ? "declarative" : "semantic-lexer",
          confidence: 0,
          capabilities: detection.adapter.capabilities,
          limitations: [],
        },
        diagnostics: detection.alternatives.some((alternative) => alternative.score === detection.score)
          ? [`Language detection is ambiguous with ${detection.alternatives[0]?.id ?? "another adapter"}.`]
          : [],
      },
    }
  }

  async #readCandidates(paths: readonly string[], signal?: AbortSignal) {
    const result = new Map<string, Candidate>()
    let completed = 0
    for (const batch of chunks(paths, this.#readConcurrency)) {
      const candidates = await Promise.all(batch.map((item) => this.#readCandidate(item, signal)))
      candidates.forEach((candidate) => {
        if (candidate) result.set(candidate.path, candidate)
      })
      completed += batch.length
      if (completed === paths.length || completed % 1_000 < batch.length)
        await this.#progress({ stage: "read", completed, total: paths.length })
    }
    return result
  }

  #analyze(candidates: readonly Candidate[]) {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const references: StoredReference[] = []
    const coverages = new Map<string, FileCoverage>()

    candidates.forEach((candidate) => {
      if (!candidate.adapter || candidate.content === undefined) {
        coverages.set(candidate.path, candidate.coverage)
        return
      }
      let analysis: AdapterAnalysis
      try {
        analysis = candidate.adapter.analyze({
          path: candidate.path,
          content: candidate.content,
          contentHash: candidate.contentHash,
        })
      } catch (error) {
        coverages.set(
          candidate.path,
          unavailableCoverage({
            path: candidate.path,
            language: candidate.adapter.id,
            contentHash: candidate.contentHash,
            status: "error",
            diagnostic: error instanceof Error ? error.message : "Language adapter failed with an unknown error.",
          }),
        )
        return
      }
      const projectedRecords =
        nodes.length +
        edges.length +
        references.length +
        analysis.nodes.length +
        analysis.edges.length +
        analysis.references.length
      if (projectedRecords > this.#maxGraphRecords)
        throw new Error(
          `Code graph analysis exceeds the ${this.#maxGraphRecords}-record node, edge, and reference budget; index a narrower source selection.`,
        )

      const occurrence = new Map<string, number>()
      const ids = new Map<string, string>()
      analysis.nodes.forEach((node) => {
        const semantic = `${node.kind}\0${node.name}`
        const sequence = occurrence.get(semantic) ?? 0
        occurrence.set(semantic, sequence + 1)
        const id = stableIdentifier(
          "node",
          candidate.path,
          candidate.adapter?.id ?? "",
          node.kind,
          node.name,
          String(sequence),
        )
        ids.set(node.key, id)
        nodes.push({
          id,
          file: candidate.path,
          language: candidate.adapter?.id ?? "unsupported",
          kind: node.kind,
          name: node.name,
          line: node.line,
          column: node.column,
          endLine: node.endLine,
          tags: [...new Set(node.tags)],
          attributes: { ...(node.attributes ?? {}), localKey: node.key },
        })
      })

      analysis.edges.forEach((edge) => {
        const source = ids.get(edge.source)
        const target = ids.get(edge.target)
        if (!source || !target) return
        edges.push({
          id: stableIdentifier("edge", source, target, edge.kind),
          source,
          target,
          sourceFile: candidate.path,
          targetFile: candidate.path,
          kind: edge.kind,
          weight: edge.weight,
          evidence: edge.evidence,
          interprocedural: false,
        })
      })
      analysis.references.forEach((reference, index) => {
        const fromNodeId = ids.get(reference.from)
        if (!fromNodeId) return
        references.push({
          id: stableIdentifier(
            "reference",
            candidate.path,
            fromNodeId,
            reference.kind,
            reference.targetName,
            String(index),
          ),
          file: candidate.path,
          fromNodeId,
          targetName: reference.targetName,
          kind: reference.kind,
          line: reference.line,
          targetLanguage: reference.targetLanguage,
          evidence: reference.evidence,
        })
      })
      const detection = this.#registry.detect({
        path: candidate.path,
        contentPrefix: candidate.content.slice(0, 65_536),
      })
      if (!detection)
        throw new Error(`Registered adapter ${candidate.adapter.id} could not redetect ${candidate.path}.`)
      coverages.set(
        candidate.path,
        analysisCoverage({
          path: candidate.path,
          language: candidate.adapter.id,
          contentHash: candidate.contentHash,
          detection,
          analysis,
        }),
      )
    })
    return { nodes, edges, references, coverages }
  }

  #enqueue<T>(operation: () => Promise<T>) {
    const result = this.#writeTail.then(operation, operation)
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  index(options: IndexOptions = {}): Promise<IndexReport> {
    return this.#enqueue(async () => {
      try {
        await this.#progress({ stage: "inventory", completed: 0 })
        const inventory = await this.#inventory(options.paths, options.signal)
        await this.#progress({ stage: "read", completed: 0, total: inventory.length })
        const initialCandidates = await this.#readCandidates(inventory, options.signal)
        const discovered = initialCandidates.size
        const previous = this.#store.fileStates()
        const explicit = options.paths !== undefined
        const missingRequested = explicit ? inventory.filter((relative) => !initialCandidates.has(relative)) : []
        const removed = explicit
          ? missingRequested.filter((relative) => previous.has(relative))
          : [...previous.keys()].filter((relative) => !initialCandidates.has(relative))
        const changed = [...initialCandidates.values()]
          .filter((candidate) => {
            const old = previous.get(candidate.path)
            const next = stateFor(candidate)
            return (
              options.force ||
              !old ||
              old.contentHash !== next.contentHash ||
              old.language !== next.language ||
              old.analysisFingerprint !== next.analysisFingerprint ||
              old.size !== next.size
            )
          })
          .map((candidate) => candidate.path)
        const reused = Math.max(0, discovered - changed.length)
        const invalidationRoots = [...new Set([...changed, ...removed])]
        const closure =
          invalidationRoots.length > 0 ? reverseDependencyClosure(invalidationRoots, this.#store.edges()) : []
        const invalidatedPaths = closure.filter((relative) => !removed.includes(relative))
        const dependentPaths = invalidatedPaths.filter((relative) => !initialCandidates.has(relative))
        const dependentCandidates = await this.#readCandidates(dependentPaths, options.signal)
        const candidates = new Map([...initialCandidates, ...dependentCandidates])
        const newlyMissing = dependentPaths.filter(
          (relative) => !dependentCandidates.has(relative) && previous.has(relative),
        )
        const allRemoved = [...new Set([...removed, ...newlyMissing])].toSorted()
        const invalidated = invalidatedPaths
          .filter((relative) => candidates.has(relative) && !allRemoved.includes(relative))
          .toSorted()
        const analyzedCandidates = invalidated.flatMap((relative) => {
          const candidate = candidates.get(relative)
          return candidate ? [candidate] : []
        })
        await this.#progress({
          stage: "analyze",
          completed: 0,
          total: analyzedCandidates.length,
          discovered,
          indexed: analyzedCandidates.length,
          reused,
        })
        const analysis = this.#analyze(analyzedCandidates)
        const indexed = analyzedCandidates.length

        const finalStates = new Map(previous)
        allRemoved.forEach((relative) => finalStates.delete(relative))
        candidates.forEach((candidate) => finalStates.set(candidate.path, stateFor(candidate)))
        const fingerprint = stableIdentifier(
          "snapshot-content",
          `reference-resolution:${REFERENCE_RESOLUTION_ALGORITHM_VERSION}`,
          ...[...finalStates.values()]
            .toSorted((left, right) => left.path.localeCompare(right.path))
            .flatMap((state) => [state.path, state.language, state.contentHash, state.analysisFingerprint]),
        )
        const createdAt = this.#now().toISOString()
        const snapshotId = stableIdentifier(
          "snapshot",
          this.#root,
          fingerprint,
          options.snapshotLabel ?? "",
          createdAt,
          this.#store.latestSnapshot()?.id ?? "initial",
        )
        const fileMutations = analyzedCandidates.map((candidate) => ({
          state: stateFor(candidate),
          coverage: analysis.coverages.get(candidate.path) ?? candidate.coverage,
        }))
        initialCandidates.clear()
        dependentCandidates.clear()
        candidates.clear()
        analyzedCandidates.splice(0)
        await this.#progress({
          stage: "commit",
          completed: 0,
          total: 1,
          discovered,
          indexed,
          reused,
        })
        this.#store.applyIndex(
          {
            snapshot: {
              id: snapshotId,
              root: this.#root,
              fingerprint,
              label: options.snapshotLabel,
              createdAt,
            },
            removed: allRemoved,
            invalidated,
            files: fileMutations,
            nodes: analysis.nodes,
            edges: analysis.edges,
            references: analysis.references,
          },
          this.#summarize,
        )

        const coverage = this.#store.coverage()
        const diagnostics = coverage
          .filter((item) => item.diagnostics.length > 0)
          .map((item) => ({ path: item.path, messages: item.diagnostics }))
        const report = {
          snapshotId,
          fingerprint,
          discovered,
          indexed,
          reused,
          invalidated,
          removed: allRemoved,
          unsupported: coverage
            .filter((item) => item.status === "unsupported" || item.status === "excluded" || item.status === "error")
            .map((item) => item.path),
          diagnostics,
          coverage,
        } satisfies IndexReport
        await this.#progress({
          stage: "complete",
          completed: 1,
          total: 1,
          discovered: report.discovered,
          indexed: report.indexed,
          reused: report.reused,
        })
        return report
      } catch (error) {
        await this.#progress({
          stage: "failed",
          completed: 0,
          error: error instanceof Error ? error.message : "Code graph indexing failed with an unknown error.",
        })
        throw error
      }
    })
  }

  query(query: GraphQuery): GraphQueryResult {
    return queryGraph(query, {
      nodes: this.#store.nodes(),
      edges: this.#store.edges(),
      coverage: this.#store.coverage(),
    })
  }

  async idle() {
    await this.#writeTail
  }
}
