// ── Automatic Ghidra Evidence Tests ──────────────────────────────
// Verifies content addressing, deduplication, phase provenance, and serialized
// concurrent updates through the real workarea writer.
// → cyberful/src/subsystem/gateway/ghidra-evidence.ts — owns the tested recorder.
// @docs/runtimes/ghidra.md
// ─────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { GhidraEvidenceRecorder } from "./ghidra-evidence"

let root = ""
let workarea = ""

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-ghidra-evidence-"))
  workarea = path.join(root, "workarea")
  await mkdir(workarea)
  workarea = await realpath(workarea)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("Ghidra evidence recorder", () => {
  test("deduplicates identical objects and preserves concurrent phase results", async () => {
    const recorder = new GhidraEvidenceRecorder(workarea, "recon")
    const result = { content: [{ type: "text" as const, text: '{"function":"fixture"}' }] }
    const [first, duplicate, graph] = await Promise.all([
      recorder.record("ghidra_decompile", { program: "/fixture", selector: "1000" }, result),
      recorder.record("ghidra_decompile", { program: "/fixture", selector: "1000" }, result),
      recorder.record("ghidra_call_graph", { program: "/fixture" }, result),
    ])
    await recorder.close()
    expect(duplicate.sha256).toBe(first.sha256)
    expect(graph.sha256).not.toBe(first.sha256)
    const index = JSON.parse(await readFile(path.join(workarea, "raw/ghidra/index.json"), "utf8"))
    expect(index.records).toHaveLength(2)
    expect(index.records.map((record: { phase: string }) => record.phase)).toEqual(["recon", "recon"])
    expect(JSON.parse(await readFile(path.join(workarea, first.path), "utf8"))).toMatchObject({
      version: 1,
      tool: "ghidra_decompile",
      phase: "recon",
    })
  })
})
