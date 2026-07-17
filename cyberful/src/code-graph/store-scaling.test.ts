// ── Code Graph Reference Scaling Guard ─────────────────────────────────────
// Uses a collision-heavy symbol bucket to keep cold and incremental reference
// resolution bounded by the per-reference candidate cap instead of graph size.
// The asserted versioned work metrics are deterministic and avoid flaky wall
// clock thresholds while still catching quadratic lookup or bucket behavior.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  CodeGraphStore,
  REFERENCE_RESOLUTION_ALGORITHM_VERSION,
  type IndexMutation,
  type StoredSnapshot,
} from "./store"
import type { FileCoverage, GraphNode } from "./types"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const capability = { level: "heuristic", detail: "Scaling fixture semantics." } as const
const coverage: FileCoverage = {
  path: "collision.ts",
  language: "typescript",
  contentHash: "a".repeat(64),
  status: "indexed",
  coverage: {
    parser: "semantic-lexer",
    confidence: 0.5,
    capabilities: {
      parsing: capability,
      symbols: capability,
      controlFlow: capability,
      callGraph: capability,
      dataFlow: capability,
      aliasing: capability,
      summaries: capability,
      securitySemantics: capability,
      crossLanguage: capability,
    },
    limitations: [],
  },
  diagnostics: [],
}

function snapshot(id: string): StoredSnapshot {
  return {
    id,
    root: "/fixture",
    fingerprint: id.padEnd(64, "0"),
    createdAt: `2026-01-01T00:00:0${id.at(-1) ?? "0"}.000Z`,
  }
}

describe("versioned reference-resolution work", () => {
  test("caps candidate probes for cold and no-change incremental rebuilds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-reference-scaling-"))
    temporaryRoots.push(root)
    const store = new CodeGraphStore(path.join(root, "index.sqlite"))
    const nodes = Array.from(
      { length: 5_000 },
      (_, index): GraphNode => ({
        id: `node-${String(index).padStart(5, "0")}`,
        file: "collision.ts",
        language: "typescript",
        kind: "function",
        name: "sharedTarget",
        line: index + 1,
        column: 1,
        endLine: index + 1,
        tags: [],
        attributes: { localKey: `function:${index}` },
      }),
    )
    const references = nodes.slice(-100).map((node, index) => ({
      id: `reference-${String(index).padStart(3, "0")}`,
      file: "collision.ts",
      fromNodeId: node.id,
      targetName: "sharedTarget",
      targetLanguage: "typescript",
      kind: "call" as const,
      line: node.line,
    }))
    const coldMutation: IndexMutation = {
      snapshot: snapshot("cold-1"),
      removed: [],
      invalidated: [],
      files: [
        {
          state: {
            path: "collision.ts",
            language: "typescript",
            contentHash: coverage.contentHash,
            analysisFingerprint: "b".repeat(64),
            size: 1,
          },
          coverage,
        },
      ],
      nodes,
      edges: [],
      references,
    }
    try {
      const cold = store.applyIndex(coldMutation, () => [])
      expect(cold).toEqual({
        algorithmVersion: REFERENCE_RESOLUTION_ALGORITHM_VERSION,
        nodes: 5_000,
        references: 100,
        candidateProbes: 1_600,
        resolvedTargets: 1_600,
        truncatedReferences: 100,
      })
      const truncatedCoverage = store.coverage()[0]
      expect(truncatedCoverage?.status).toBe("degraded")
      expect(truncatedCoverage?.diagnostics).toHaveLength(1)
      expect(truncatedCoverage?.diagnostics[0]).toContain("first 16 matching symbols")
      expect(truncatedCoverage?.coverage.limitations).toContain(truncatedCoverage?.diagnostics[0] ?? "")
      const incremental = store.applyIndex(
        {
          snapshot: snapshot("incremental-2"),
          removed: [],
          invalidated: [],
          files: [],
          nodes: [],
          edges: [],
          references: [],
        },
        () => [],
      )
      expect(incremental).toEqual(cold)
      expect(store.coverage()[0]?.diagnostics).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})
