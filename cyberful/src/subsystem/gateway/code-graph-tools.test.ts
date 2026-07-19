// ── Code Graph Gateway Boundary Tests ───────────────────────────
// Exercises lazy ownership, canonical source precedence, fixed workflow
// exports, finding lifecycle gates, and host-keyed fixed-status attestations.
// → cyberful/src/subsystem/gateway/code-graph-tools.ts — owns the tested boundary.
// ─────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { createCodeGraphService } from "../../code-graph/service"
import {
  CODE_GRAPH_TOOL_DEFS,
  codeGraphToolsAvailable,
  createCodeGraphToolHandler,
  isCodeGraphTool,
  verifyCodeGraphReadiness,
} from "./code-graph-tools"
import { attestSourceImportManifest, sourceImportTreeFingerprint } from "./source-import"
import { isRecord } from "@/util/record"

const temporaryRoots: string[] = []
const ledgerKey = "gateway-test-ledger-key-with-at-least-thirty-two-bytes"
const importKey = "gateway-test-import-key-with-at-least-thirty-two-bytes"

type Workflow = "code-audit" | "assessment" | "remediate" | "secure-review"

function recordValue(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} is not an object`)
  return value
}

function recordArray(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${context} is not an array`)
  return value.map((item) => recordValue(item, `${context} item`))
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} is not a string`)
  return value
}

async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function runGit(args: readonly string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0] ?? "command"} failed`)
  return stdout.trim()
}

async function fixture(workflow: Workflow, includeKey = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-gateway-"))
  temporaryRoots.push(root)
  const sourceRoot = path.join(root, "source")
  const workareaRoot = path.join(root, "workarea")
  const sourceStoreRoot = path.join(root, "source-store")
  await mkdir(sourceRoot)
  await mkdir(workareaRoot)
  await mkdir(path.join(sourceStoreRoot, "import"), { recursive: true })
  await writeFile(path.join(sourceRoot, "project.ts"), "export function projectEntry() { return 1 }\n")
  const environment: Record<string, string | undefined> = {
    CYBERFUL_SUBSYSTEM_WORKFLOW: workflow,
    CYBERFUL_SUBSYSTEM_SOURCE_ROOT: sourceRoot,
    CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: workareaRoot,
    CYBERFUL_SOURCE_STORE_ROOT: sourceStoreRoot,
    CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY: importKey,
  }
  if (includeKey) environment.CYBERFUL_CODE_GRAPH_LEDGER_KEY = ledgerKey
  return { root, sourceRoot, workareaRoot, sourceStoreRoot, environment }
}

function findingRecord(workflow: Workflow) {
  return {
    action: "record",
    workflow,
    title: "Untrusted command reaches a shell",
    weakness: "CWE-78",
    severity: "high",
    confidence: "high",
    locations: [{ path: "project.ts", startLine: 1 }],
    evidence: [{ kind: "test", description: "A controlled regression test reproduced command execution." }],
    remediation: "Invoke a fixed executable with a validated argument vector.",
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Code Graph gateway registration and ownership", () => {
  test("registers only the four bounded tools and creates one service lazily", async () => {
    const { sourceRoot, workareaRoot, environment } = await fixture("code-audit")
    expect(CODE_GRAPH_TOOL_DEFS.map((tool) => tool.name)).toEqual([
      "code_graph_index",
      "code_graph_query",
      "code_finding",
      "code_graph_manifest",
    ])
    expect(isCodeGraphTool("code_graph_query")).toBe(true)
    expect(isCodeGraphTool("source_read")).toBe(false)
    expect(codeGraphToolsAvailable(environment)).toBe(true)
    expect(codeGraphToolsAvailable({ ...environment, CYBERFUL_SUBSYSTEM_WORKFLOW: "pentest" })).toBe(false)
    expect(codeGraphToolsAvailable({ ...environment, CYBERFUL_SUBSYSTEM_SOURCE_ROOT: "relative" })).toBe(false)

    const database = path.join(workareaRoot, "raw", "code-graph", "index.sqlite")
    let creations = 0
    const handler = createCodeGraphToolHandler({
      environment,
      serviceFactory: async (options) => {
        creations += 1
        return createCodeGraphService(options)
      },
    })
    expect(await exists(database)).toBe(false)
    const [first, second] = await Promise.all([
      handler.handle("code_graph_manifest", {}),
      handler.handle("code_graph_manifest", {}),
    ])
    expect(first).toEqual(second)
    expect(creations).toBe(1)
    expect(await exists(database)).toBe(true)
    expect(JSON.stringify(first)).not.toContain(sourceRoot)
    expect(JSON.stringify(first)).not.toContain(workareaRoot)
    expect(JSON.stringify(first)).not.toContain(ledgerKey)

    await handler.close()
    await handler.close()
    await expect(handler.handle("code_graph_manifest", {})).rejects.toThrow("closed")
  })

  test("does not materialize storage when a never-used handler closes", async () => {
    const { workareaRoot, environment } = await fixture("assessment")
    const handler = createCodeGraphToolHandler({ environment })
    await handler.close()
    expect(await exists(path.join(workareaRoot, "raw", "code-graph", "index.sqlite"))).toBe(false)
  })

  test("omits initial status from the record schema", () => {
    const definition = CODE_GRAPH_TOOL_DEFS.find((tool) => tool.name === "code_finding")
    const schema = recordValue(definition?.inputSchema, "code finding input schema")
    const variants = recordArray(schema.oneOf, "code finding input variants")
    expect(recordValue(variants[0]?.properties, "record finding properties")).not.toHaveProperty("status")
    expect(recordValue(variants[3]?.properties, "transition finding properties")).toHaveProperty("status")
  })
})

describe("canonical analysis source selection", () => {
  test("prefers a verified repository import over a durable source snapshot", async () => {
    const { sourceStoreRoot, environment } = await fixture("code-audit")
    const importRoot = path.join(sourceStoreRoot, "import")
    const imported = path.join(importRoot, "repository")
    const snapshot = path.join(sourceStoreRoot, "snapshot", "tree")
    await mkdir(imported, { recursive: true })
    await mkdir(snapshot, { recursive: true })
    await runGit(["init", "--quiet"], imported)
    await writeFile(path.join(imported, "imported.ts"), "export function importedEntry() { return 2 }\n")
    await runGit(["add", "--", "imported.ts"], imported)
    await runGit(
      ["-c", "user.name=Cyberful Tests", "-c", "user.email=cyberful@localhost", "commit", "--quiet", "-m", "fixture"],
      imported,
    )
    const commit = await runGit(["rev-parse", "HEAD"], imported)
    const tree = await sourceImportTreeFingerprint(imported)
    const manifest = attestSourceImportManifest(
      {
        version: 2,
        url: "https://github.com/example/project.git",
        host: "github.com",
        additional_refs: [],
        local_refs: {},
        sealed_refs: [],
        commit,
        tree,
        resolved_addresses: ["8.8.8.8"],
        files_on_disk: tree.files,
        bytes_on_disk: tree.bytes,
        network_complete: true,
        history_complete: false,
        hooks: false,
        submodules: false,
        lfs_smudge: false,
        dependencies: false,
        created_at: "2026-07-16T12:00:00.000Z",
      },
      environment,
    )
    await writeFile(path.join(importRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    await writeFile(path.join(snapshot, "snapshot.ts"), "export function snapshotEntry() { return 3 }\n")
    const handler = createCodeGraphToolHandler({ environment })
    try {
      expect(await handler.handle("code_graph_manifest", {})).toMatchObject({ source: "source-import" })
      await handler.handle("code_graph_index", {})
      const importedResult = recordValue(
        await handler.handle("code_graph_query", { kind: "symbols", name: "importedEntry" }),
        "imported symbol query",
      )
      const snapshotResult = recordValue(
        await handler.handle("code_graph_query", { kind: "symbols", name: "snapshotEntry" }),
        "snapshot symbol query",
      )
      expect(recordArray(importedResult.nodes, "imported symbol nodes").map((node) => node.name)).toContain(
        "importedEntry",
      )
      expect(snapshotResult.nodes).toEqual([])
    } finally {
      await handler.close()
    }
  })

  test("uses the isolated remediation checkout before imports", async () => {
    const { workareaRoot, sourceStoreRoot, environment } = await fixture("remediate")
    const checkout = path.join(workareaRoot, "remediation", "checkout")
    const imported = path.join(sourceStoreRoot, "import", "repository")
    await mkdir(checkout, { recursive: true })
    await mkdir(imported, { recursive: true })
    await writeFile(path.join(checkout, "fixed.ts"), "export function checkoutEntry() { return 4 }\n")
    await writeFile(path.join(imported, "imported.ts"), "export function importedEntry() { return 2 }\n")
    const handler = createCodeGraphToolHandler({ environment })
    try {
      expect(await handler.handle("code_graph_manifest", {})).toMatchObject({ source: "remediation-checkout" })
      await handler.handle("code_graph_index", {})
      const result = recordValue(
        await handler.handle("code_graph_query", { kind: "symbols", name: "checkoutEntry" }),
        "checkout symbol query",
      )
      expect(recordArray(result.nodes, "checkout symbol nodes").map((node) => node.name)).toContain("checkoutEntry")
    } finally {
      await handler.close()
    }
  })

  test("fails closed when a preferred source component is a symlink", async () => {
    if (process.platform === "win32") return
    const { root, sourceStoreRoot, environment } = await fixture("secure-review")
    const outside = path.join(root, "outside")
    await mkdir(outside)
    await symlink(outside, path.join(sourceStoreRoot, "import", "repository"), "dir")
    const handler = createCodeGraphToolHandler({ environment })
    await expect(handler.handle("code_graph_manifest", {})).rejects.toThrow("symlink")
    await handler.close()
  })
})

describe("Code Audit graph readiness", () => {
  test("attests current source, snapshot, and coverage and rejects marker tampering", async () => {
    const { workareaRoot, environment } = await fixture("code-audit")
    const handler = createCodeGraphToolHandler({ environment })
    await handler.handle("code_graph_index", {})
    await handler.close()

    await expect(verifyCodeGraphReadiness(environment)).resolves.toMatchObject({
      version: 1,
      workflow: "code-audit",
      source_kind: "project-source",
      coverage_entries: 1,
    })

    const readinessPath = path.join(workareaRoot, "raw", "code-graph", "readiness.json")
    const readiness = recordValue(JSON.parse(await readFile(readinessPath, "utf8")), "readiness attestation")
    await writeFile(readinessPath, JSON.stringify({ ...readiness, hmac_sha256: "0".repeat(64) }))
    await expect(verifyCodeGraphReadiness(environment)).rejects.toThrow("does not match")
  })

  test("does not attest a path-limited index as repository-wide coverage", async () => {
    const { environment } = await fixture("code-audit")
    const handler = createCodeGraphToolHandler({ environment })
    await handler.handle("code_graph_index", { paths: ["project.ts"] })
    await handler.close()
    await expect(verifyCodeGraphReadiness(environment)).rejects.toThrow()
  })
})

describe("workflow-owned exports", () => {
  test("uses fixed report paths and formats for every workflow", async () => {
    const cases = [
      ["code-audit", "reports/code-audit.sarif", "sarif"],
      ["secure-review", "reports/secure-review.sarif", "sarif"],
      ["assessment", "reports/assessment-evidence.json", "evidence"],
      ["remediate", "reports/remediation-evidence.json", "evidence"],
    ] as const
    for (const [workflow, expectedPath, expectedFormat] of cases) {
      const { workareaRoot, environment } = await fixture(workflow)
      const handler = createCodeGraphToolHandler({ environment })
      try {
        const result = recordValue(await handler.handle("code_finding", { action: "export" }), "finding export")
        expect(result).toMatchObject({ path: expectedPath, format: expectedFormat })
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(await exists(path.join(workareaRoot, expectedPath))).toBe(true)
        await expect(
          handler.handle("code_finding", { action: "export", path: "reports/caller-choice.json" }),
        ).rejects.toThrow("fixed")
      } finally {
        await handler.close()
      }
    }
  })
})

describe("host-attested finding lifecycle", () => {
  test("accepts fixed only with host proof and rejects missing, deleted, or tampered attestations", async () => {
    const { workareaRoot, environment } = await fixture("remediate")
    const handler = createCodeGraphToolHandler({
      environment,
      authorizeFixedTransition: async () => ({ ok: true }),
    })
    try {
      const record = findingRecord("remediate")
      const suspected = recordValue(await handler.handle("code_finding", record), "recorded finding")
      const suspectedID = stringValue(suspected.id, "recorded finding id")
      expect(suspected.status).toBe("suspected")
      const confirmed = recordValue(
        await handler.handle("code_finding", {
          action: "transition",
          id: suspectedID,
          status: "confirmed",
          reason: "The vulnerable regression case failed before the fix.",
        }),
        "confirmed finding",
      )
      expect(confirmed.status).toBe("confirmed")
      const fixed = recordValue(
        await handler.handle("code_finding", {
          action: "transition",
          id: suspectedID,
          status: "fixed",
          reason: "The same case passed after the fix and variant tests found no residual path.",
        }),
        "fixed finding",
      )
      expect(fixed.status).toBe("fixed")
      expect(await handler.fixedFindings([suspectedID])).toEqual({ ok: true, unresolved: [] })

      const attestation = path.join(workareaRoot, "raw", "code-graph", "attestations", `${suspectedID}.json`)
      const attested = recordValue(JSON.parse(await readFile(attestation, "utf8")), "finding attestation")
      expect(attested).toMatchObject({ version: 2, transition_count: 2 })
      expect(JSON.stringify(attested)).not.toContain(ledgerKey)
      await writeFile(attestation, JSON.stringify({ ...attested, hmac_sha256: "0".repeat(64) }))
      expect(await handler.fixedFindings([suspectedID])).toEqual({ ok: false, unresolved: [suspectedID] })

      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "residual",
        reason: "Attestation recovery reopens the finding for verification.",
      })
      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "fixed",
        reason: "Host verification reproduced the fixed result before re-attestation.",
      })
      await unlink(attestation)
      expect(await handler.fixedFindings([suspectedID])).toEqual({ ok: false, unresolved: [suspectedID] })

      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "residual",
        reason: "Deleted attestation reopens the finding for verification.",
      })
      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "fixed",
        reason: "Host verification reproduced the fixed result after recovery.",
      })
      const database = new Database(path.join(workareaRoot, "raw", "code-graph", "index.sqlite"))
      database.query("UPDATE findings SET remediation = ? WHERE id = ?").run("tampered outside the ledger", suspectedID)
      database.close()
      expect(await handler.fixedFindings([suspectedID])).toEqual({ ok: false, unresolved: [suspectedID] })
      await expect(handler.handle("code_finding", record)).rejects.toThrow("cannot be changed or re-attested")
    } finally {
      await handler.close()
    }
  })

  test("denies fixed without the remediation proof hook", async () => {
    const { environment } = await fixture("remediate")
    const handler = createCodeGraphToolHandler({ environment })
    try {
      const suspected = recordValue(
        await handler.handle("code_finding", findingRecord("remediate")),
        "recorded finding",
      )
      const suspectedID = stringValue(suspected.id, "recorded finding id")
      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "confirmed",
        reason: "Reproduced before the fix.",
      })
      await expect(
        handler.handle("code_finding", {
          action: "transition",
          id: suspectedID,
          status: "fixed",
          reason: "Claimed fixed without host evidence.",
        }),
      ).rejects.toThrow("host-attested")
      expect(await handler.fixedFindings([suspectedID])).toEqual({ ok: false, unresolved: [suspectedID] })
    } finally {
      await handler.close()
    }
  })

  test("fails closed when direct SQLite writes tamper with a finding or its transition history", async () => {
    const { workareaRoot, environment } = await fixture("code-audit")
    const handler = createCodeGraphToolHandler({ environment })
    const reason = "A controlled exploit and negative control confirmed the vulnerable path."
    try {
      const suspected = recordValue(
        await handler.handle("code_finding", findingRecord("code-audit")),
        "recorded finding",
      )
      const suspectedID = stringValue(suspected.id, "recorded finding id")
      await handler.handle("code_finding", {
        action: "transition",
        id: suspectedID,
        status: "confirmed",
        reason,
      })
      await handler.handle("code_finding", { action: "export" })

      const databasePath = path.join(workareaRoot, "raw", "code-graph", "index.sqlite")
      const database = new Database(databasePath)
      database
        .query("UPDATE finding_transitions SET reason = ? WHERE finding_id = ?")
        .run("transition changed outside the host ledger", suspectedID)
      database.close()
      await expect(handler.handle("code_finding", { action: "export" })).rejects.toThrow("host attestation")

      const secondDatabase = new Database(databasePath)
      secondDatabase.query("UPDATE finding_transitions SET reason = ? WHERE finding_id = ?").run(reason, suspectedID)
      secondDatabase.query("UPDATE findings SET title = ? WHERE id = ?").run("forged finding title", suspectedID)
      secondDatabase.close()
      await expect(handler.handle("code_finding", { action: "export" })).rejects.toThrow("host attestation")
    } finally {
      await handler.close()
    }
  })

  test("rejects caller-supplied initial status and mutations without a ledger key", async () => {
    const keyed = await fixture("code-audit")
    const keyedHandler = createCodeGraphToolHandler({ environment: keyed.environment })
    try {
      await expect(
        keyedHandler.handle("code_finding", { ...findingRecord("code-audit"), status: "fixed" }),
      ).rejects.toThrow("always start as suspected")
    } finally {
      await keyedHandler.close()
    }

    const unkeyed = await fixture("assessment", false)
    const unkeyedHandler = createCodeGraphToolHandler({ environment: unkeyed.environment })
    try {
      await expect(unkeyedHandler.handle("code_finding", findingRecord("assessment"))).rejects.toThrow(
        "attestation is unavailable",
      )
      expect(await unkeyedHandler.handle("code_finding", { action: "list" })).toEqual([])
      const id = "a".repeat(64)
      await expect(unkeyedHandler.fixedFindings([id])).rejects.toThrow("attestation is unavailable")
    } finally {
      await unkeyedHandler.close()
    }
  })
})
