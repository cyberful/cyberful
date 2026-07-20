// ── Code Graph Service Behavior Tests ───────────────────────────────────────
// Exercises the public facade against real temporary source trees and SQLite:
// cold/incremental indexing, reverse invalidation, taint traversal, finding
// lifecycle gates, contained exports, private permissions, and idempotent
// cleanup. No daemon, network, home directory, or compiler is required.
// ─────────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LanguageRegistry } from "./registry"
import { createSemanticLanguageAdapter } from "./semantic-adapter"
import { createCodeGraphService } from "./service"
import { CodeGraphStore } from "./store"

const temporaryRoots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-"))
  temporaryRoots.push(root)
  const sourceRoot = path.join(root, "source")
  const workareaRoot = path.join(root, "workarea")
  await mkdir(sourceRoot)
  await Bun.write(
    path.join(sourceRoot, "input.ts"),
    "export function readInput() {\n  const value = request.body\n  return value\n}\n",
  )
  await Bun.write(
    path.join(sourceRoot, "execute.ts"),
    'import { readInput } from "./input"\nexport function run() {\n  const value = readInput()\n  exec(value)\n}\n',
  )
  const service = await createCodeGraphService({ sourceRoot, workareaRoot })
  return { root, sourceRoot, workareaRoot, service }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("incremental code graph service", () => {
  test("indexes vendor and editor configuration as auditable source", async () => {
    const { sourceRoot, service } = await fixture()
    try {
      await Promise.all([
        mkdir(path.join(sourceRoot, "vendor")),
        mkdir(path.join(sourceRoot, ".vscode")),
      ])
      await Promise.all([
        Bun.write(path.join(sourceRoot, "vendor", "bubblewrap.c"), "int sandbox(void) { return 1; }\n"),
        Bun.write(path.join(sourceRoot, ".vscode", "settings.json"), '{"security.audit": true}\n'),
      ])
      const report = await service.index()
      expect(report.coverage.map((entry) => entry.path)).toContain("vendor/bubblewrap.c")
      expect(report.coverage.map((entry) => entry.path)).toContain(".vscode/settings.json")
    } finally {
      await service.close()
    }
  })

  test("migrates the legacy finding mode column to workflow without losing records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-migration-"))
    temporaryRoots.push(root)
    const databasePath = path.join(root, "index.sqlite")
    const legacy = new Database(databasePath, { create: true, strict: true })
    legacy.exec(`
      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        title TEXT NOT NULL,
        weakness TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        locations_json TEXT NOT NULL,
        traces_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        remediation TEXT NOT NULL,
        base_ref TEXT,
        head_ref TEXT,
        related_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
    const id = "a".repeat(64)
    legacy
      .query(
        "INSERT INTO findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        "code-audit",
        "Legacy finding",
        "CWE-78",
        "high",
        "high",
        "suspected",
        JSON.stringify([{ path: "legacy.ts", startLine: 1 }]),
        "[]",
        JSON.stringify([{ kind: "manual", description: "Legacy evidence." }]),
        "Validate the argument vector.",
        null,
        null,
        "[]",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )
    legacy.close()

    const store = new CodeGraphStore(databasePath)
    try {
      expect(store.finding(id)?.workflow).toBe("code-audit")
    } finally {
      store.close()
    }
  })

  test("rejects invalid indexing resource limits before creating project state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-limits-"))
    temporaryRoots.push(root)
    await expect(
      createCodeGraphService({
        sourceRoot: path.join(root, "missing-source"),
        workareaRoot: path.join(root, "workarea"),
        readConcurrency: Number.NaN,
      }),
    ).rejects.toThrow("readConcurrency must be a positive safe integer")
  })

  test("fails explicitly when analysis exceeds the aggregate graph record budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-budget-"))
    temporaryRoots.push(root)
    const sourceRoot = path.join(root, "source")
    await mkdir(sourceRoot)
    await Bun.write(path.join(sourceRoot, "module.ts"), "export function run() { return request.body }\n")
    const service = await createCodeGraphService({
      sourceRoot,
      workareaRoot: path.join(root, "workarea"),
      maxGraphRecords: 1,
    })
    try {
      await expect(service.index()).rejects.toThrow("1-record node, edge, and reference budget")
      expect(await Bun.file(service.progressPath).text()).toContain('"status": "failed"')
    } finally {
      await service.close()
    }
  })

  test("indexes once, reuses unchanged files, and invalidates reverse callers", async () => {
    const { sourceRoot, service } = await fixture()
    try {
      const cold = await service.index({ snapshotLabel: "cold" })
      expect(cold.discovered).toBe(2)
      expect(cold.indexed).toBe(2)
      expect(cold.unsupported).toEqual([])
      expect(cold.coverage.every((item) => item.status === "indexed")).toBe(true)

      const symbols = service.query({ kind: "symbols", name: "readInput" })
      expect(symbols.nodes.some((node) => node.kind === "function" && node.file === "input.ts")).toBe(true)
      const taint = service.query({ kind: "taint", maxDepth: 20, maxPaths: 10 })
      expect(taint.paths.length).toBeGreaterThan(0)
      expect(taint.nodes.some((node) => node.tags.includes("source"))).toBe(true)
      expect(taint.nodes.some((node) => node.tags.includes("sink"))).toBe(true)

      const unchanged = await service.index({ snapshotLabel: "unchanged" })
      expect(unchanged.indexed).toBe(0)
      expect(unchanged.reused).toBe(2)
      const progress: unknown = JSON.parse(await Bun.file(service.progressPath).text())
      expect(progress).toMatchObject({
        stage: "complete",
        status: "complete",
        discovered: 2,
        indexed: 0,
        reused: 2,
        resources: {
          walBytes: 0,
        },
      })
      expect((await stat(service.databasePath)).size).toBeGreaterThan(0)
      expect((await stat(`${service.databasePath}-wal`)).size).toBe(0)

      await Bun.write(
        path.join(sourceRoot, "input.ts"),
        "export function readInput() {\n  const value = request.body\n  validate(value)\n  return value\n}\n",
      )
      const incremental = await service.index({ paths: ["input.ts"], snapshotLabel: "changed" })
      expect(incremental.invalidated).toEqual(["execute.ts", "input.ts"])
      expect(incremental.indexed).toBe(2)

      await unlink(path.join(sourceRoot, "input.ts"))
      const deletion = await service.index({ paths: ["input.ts"], snapshotLabel: "deleted" })
      expect(deletion.removed).toEqual(["input.ts"])
      expect(deletion.invalidated).toContain("execute.ts")
      expect(service.query({ kind: "symbols", file: "input.ts" }).nodes).toEqual([])
    } finally {
      await service.close()
    }
  })

  test("reindexes unchanged source when its adapter implementation changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-adapter-upgrade-"))
    temporaryRoots.push(root)
    const sourceRoot = path.join(root, "source")
    const workareaRoot = path.join(root, "workarea")
    await mkdir(sourceRoot)
    await Bun.write(path.join(sourceRoot, "module.ts"), "export function run() { return 1 }\n")
    const base = createSemanticLanguageAdapter({
      id: "typescript",
      displayName: "TypeScript",
      version: "1.0.0",
      extensions: [".ts"],
      domains: ["application"],
    })
    const registry = (implementationDigest: string) =>
      new LanguageRegistry([
        {
          ...base,
          implementation: { ...base.implementation, digest: implementationDigest },
        },
      ])

    const first = await createCodeGraphService({
      sourceRoot,
      workareaRoot,
      registry: registry("1".repeat(64)),
    })
    const cold = await first.index().finally(() => first.close())

    const unchanged = await createCodeGraphService({
      sourceRoot,
      workareaRoot,
      registry: registry("1".repeat(64)),
    })
    try {
      expect((await unchanged.index()).indexed).toBe(0)
    } finally {
      await unchanged.close()
    }

    const upgraded = await createCodeGraphService({
      sourceRoot,
      workareaRoot,
      registry: registry("2".repeat(64)),
    })
    try {
      const report = await upgraded.index()
      expect(report.indexed).toBe(1)
      expect(report.reused).toBe(0)
      expect(report.fingerprint).not.toBe(cold.fingerprint)
    } finally {
      await upgraded.close()
    }
  })

  test("rejects traversal and keeps its SQLite files private", async () => {
    const { root, sourceRoot, service } = await fixture()
    try {
      expect(() => service.query({ kind: "symbols", file: "../outside.ts" })).toThrow("relative")
      await expect(service.index({ paths: ["../outside.ts"] })).rejects.toThrow("relative")
      await service.index()
      if (process.platform !== "win32") expect((await stat(service.databasePath)).mode & 0o777).toBe(0o600)
      if (process.platform !== "win32") {
        await symlink(service.workareaRoot, path.join(sourceRoot, "linked-workarea"), "dir")
        const excluded = await service.index({ paths: ["linked-workarea/raw/code-graph/index.sqlite"] })
        expect(excluded.discovered).toBe(0)

        const outside = path.join(root, "outside")
        await mkdir(outside)
        await symlink(outside, path.join(service.workareaRoot, "reports"), "dir")
        await expect(service.exportEvidence("reports/evidence.json")).rejects.toThrow("plain directory")
      }
    } finally {
      await service.close()
      await service.close()
    }
    expect(() => service.query({ kind: "coverage" })).toThrow("closed")
  })

  test("refuses a pre-existing database symlink", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-link-"))
    temporaryRoots.push(root)
    const sourceRoot = path.join(root, "source")
    const workareaRoot = path.join(root, "workarea")
    const graphRoot = path.join(workareaRoot, "raw", "code-graph")
    await mkdir(sourceRoot)
    await mkdir(graphRoot, { recursive: true })
    const outside = path.join(root, "outside.sqlite")
    await Bun.write(outside, "not a database")
    await symlink(outside, path.join(graphRoot, "index.sqlite"))
    await expect(createCodeGraphService({ sourceRoot, workareaRoot })).rejects.toThrow("plain file")
  })
})

describe("finding ledger exports", () => {
  test("keeps suspected findings out of SARIF until verification and retains the audit trail", async () => {
    const { service } = await fixture()
    try {
      await service.index()
      const finding = service.recordFinding({
        workflow: "code-audit",
        title: "Command injection reaches exec",
        weakness: "CWE-78",
        severity: "high",
        confidence: "high",
        status: "confirmed",
        locations: [{ path: "execute.ts", startLine: 4, message: "Untrusted value reaches exec." }],
        evidence: [{ kind: "code", description: "Interprocedural taint path from request.body to exec." }],
        remediation: "Use a fixed executable and pass validated arguments without a shell.",
      })
      expect(finding.status).toBe("suspected")
      const unverified = await service.exportSarif("reports/code-audit.sarif")
      expect(await Bun.file(unverified.path).text()).not.toContain('"ruleId": "CWE-78"')

      const confirmed = service.transitionFinding({
        id: finding.id,
        status: "confirmed",
        reason: "A regression test reproduced shell metacharacter execution.",
      })
      expect(confirmed.status).toBe("confirmed")
      expect(service.getFinding(finding.id)?.status).toBe("confirmed")
      expect(service.listFindings({ statuses: ["confirmed"] })).toHaveLength(1)

      const repeated = service.recordFinding({
        workflow: "code-audit",
        title: "Command injection reaches exec",
        weakness: "CWE-78",
        severity: "critical",
        confidence: "confirmed",
        status: "suspected",
        locations: [{ path: "execute.ts", startLine: 4 }],
        evidence: [{ kind: "test", description: "The exploit regression test is deterministic." }],
        remediation: "Replace shell execution with a fixed argument-vector invocation.",
      })
      expect(repeated.id).toBe(finding.id)
      expect(repeated.status).toBe("confirmed")

      const sarif = await service.exportSarif("reports/code-audit.sarif")
      const sarifText = await Bun.file(sarif.path).text()
      expect(sarifText).toContain('"ruleId": "CWE-78"')
      expect(sarifText).toContain(`"cyberfulFindingId": "${finding.id}"`)
      const evidence = await service.exportEvidence("reports/code-audit-evidence.json")
      const evidenceText = await Bun.file(evidence.path).text()
      expect(evidenceText).toContain('"fromStatus": "suspected"')
      expect(evidenceText).toContain('"toStatus": "confirmed"')
      expect(sarif.path.startsWith(service.workareaRoot)).toBe(true)
      await expect(service.exportSarif("../escape.sarif")).rejects.toThrow("workarea")
      expect(() =>
        service.recordFinding({
          workflow: "code-audit",
          title: "Invalid path",
          weakness: "CWE-22",
          severity: "low",
          confidence: "low",
          locations: [{ path: "../outside", startLine: 1 }],
          evidence: [{ kind: "manual", description: "Invalid fixture." }],
          remediation: "None.",
        }),
      ).toThrow("relative")
    } finally {
      await service.close()
    }
  })
})
