// ── Code Graph Atomic Index Tests ───────────────────────────────────────────
// Proves that snapshot, graph, resolved references, and summaries advance as
// one SQLite transaction. An injected summary failure must reject indexing and
// leave the previous snapshot, file hashes, nodes, and edges byte-for-byte
// observable instead of exposing a new graph with stale summaries.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildFunctionSummaries } from "./algorithms"
import { CodeGraphEngine } from "./engine"
import { CodeGraphStore } from "./store"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("atomic graph and summary commit", () => {
  test("rolls back the entire candidate snapshot when summary construction fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-graph-atomic-"))
    temporaryRoots.push(root)
    const source = path.join(root, "source")
    await mkdir(source)
    const database = path.join(root, "index.sqlite")
    const store = new CodeGraphStore(database)
    let rejectSummaries = false
    const engine = new CodeGraphEngine({
      sourceRoot: source,
      store,
      summarize: (nodes, edges) => {
        if (rejectSummaries) throw new Error("injected summary failure")
        return buildFunctionSummaries(nodes, edges)
      },
    })
    try {
      await Bun.write(path.join(source, "service.ts"), "export function safe() {\n  return 1\n}\n")
      await engine.index({ snapshotLabel: "accepted" })
      const accepted = {
        snapshot: store.latestSnapshot(),
        files: [...store.fileStates()],
        nodes: store.nodes(),
        edges: store.edges(),
        coverage: store.coverage(),
      }

      await Bun.write(
        path.join(source, "service.ts"),
        "export function unsafe() {\n  const value = request.body\n  exec(value)\n}\n",
      )
      rejectSummaries = true
      await expect(engine.index({ snapshotLabel: "must-rollback" })).rejects.toThrow("injected summary failure")
      expect(store.latestSnapshot()).toEqual(accepted.snapshot)
      expect([...store.fileStates()]).toEqual(accepted.files)
      expect(store.nodes()).toEqual(accepted.nodes)
      expect(store.edges()).toEqual(accepted.edges)
      expect(store.coverage()).toEqual(accepted.coverage)
    } finally {
      await engine.idle()
      store.close()
    }
  })
})
