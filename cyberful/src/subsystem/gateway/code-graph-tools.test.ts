// ── Code Graph Gateway Boundary Tests ───────────────────────────
// Locks Code Audit-only availability, phase ownership of finding mutations,
// and host-generated SARIF plus evidence exports.
// → cyberful/src/subsystem/gateway/code-graph-tools.ts — owns the boundary.
// ────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import {
  CODE_GRAPH_TOOL_DEFS,
  codeGraphToolsAvailable,
  createCodeGraphToolHandler,
  isCodeGraphTool,
} from "./code-graph-tools"

const roots: string[] = []
const ledgerKey = "gateway-test-ledger-key-with-at-least-thirty-two-bytes"

async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function fixture(phase: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-code-graph-gateway-"))
  roots.push(root)
  const sourceRoot = path.join(root, "source")
  const workareaRoot = path.join(root, "workarea")
  const sourceStoreRoot = path.join(root, "source-store")
  await mkdir(sourceRoot)
  await mkdir(workareaRoot)
  await mkdir(path.join(sourceStoreRoot, "import"), { recursive: true })
  await writeFile(path.join(sourceRoot, "project.ts"), "export function projectEntry(input: string) { return input }\n")
  return {
    root,
    sourceRoot,
    workareaRoot,
    environment: {
      CYBERFUL_SUBSYSTEM_WORKFLOW: "code-audit",
      CYBERFUL_SUBSYSTEM_PHASE: phase,
      CYBERFUL_SUBSYSTEM_SOURCE_ROOT: sourceRoot,
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: workareaRoot,
      CYBERFUL_SOURCE_STORE_ROOT: sourceStoreRoot,
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: ledgerKey,
    },
  }
}

function finding() {
  return {
    action: "record",
    workflow: "code-audit",
    title: "Untrusted command reaches a shell",
    weakness: "CWE-78",
    severity: "high",
    confidence: "high",
    locations: [{ path: "project.ts", startLine: 1 }],
    evidence: [{ kind: "test", description: "A controlled lab test reproduced command execution." }],
    remediation: "Invoke a fixed executable with a validated argument vector.",
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Code Graph gateway", () => {
  test("publishes graph and finding tools only for Code Audit", async () => {
    const { environment } = await fixture("index")
    expect(codeGraphToolsAvailable(environment)).toBe(true)
    expect(codeGraphToolsAvailable({ ...environment, CYBERFUL_SUBSYSTEM_WORKFLOW: "pentest" })).toBe(false)
    expect(CODE_GRAPH_TOOL_DEFS.map((tool) => tool.name)).toEqual([
      "code_graph_index",
      "code_graph_query",
      "code_finding",
      "code_graph_manifest",
    ])
    expect(isCodeGraphTool("code_finding")).toBe(true)
    expect(isCodeGraphTool("unknown")).toBe(false)
  })

  test("Hunt records candidates, Verify disposes them, and Report exports both formats", async () => {
    const { environment, workareaRoot } = await fixture("hunt")
    const hunt = createCodeGraphToolHandler({ environment })
    const candidate = (await hunt.handle("code_finding", finding())) as { id: string; status: string }
    expect(candidate.id).toMatch(/^[a-f0-9]{64}$/)
    expect(candidate.status).toBe("suspected")
    await expect(
      hunt.handle("code_finding", {
        action: "transition",
        id: candidate.id,
        status: "confirmed",
        reason: "not Hunt's decision",
      }),
    ).rejects.toThrow("Only Code Audit Verify")
    await hunt.close()

    const verify = createCodeGraphToolHandler({ environment: { ...environment, CYBERFUL_SUBSYSTEM_PHASE: "verify" } })
    const confirmed = (await verify.handle("code_finding", {
      action: "transition",
      id: candidate.id,
      status: "confirmed",
      reason: "fresh lab reproduction and negative control",
    })) as { status: string }
    expect(confirmed.status).toBe("confirmed")
    await verify.close()

    const report = createCodeGraphToolHandler({ environment: { ...environment, CYBERFUL_SUBSYSTEM_PHASE: "report" } })
    const output = (await report.handle("code_finding", { action: "export" })) as {
      exports: Array<{ format: string; path: string }>
    }
    expect(output.exports.map((item) => [item.format, item.path])).toEqual([
      ["sarif", "reports/code-audit.sarif"],
      ["evidence", "reports/code-audit-evidence.json"],
    ])
    expect(await exists(path.join(workareaRoot, "reports", "code-audit.sarif"))).toBe(true)
    expect(await exists(path.join(workareaRoot, "reports", "code-audit-evidence.json"))).toBe(true)
    const sarif = JSON.parse(await readFile(path.join(workareaRoot, "reports", "code-audit.sarif"), "utf8"))
    expect(sarif.runs[0].results).toHaveLength(1)
    await report.close()
  })

  test("Scope cannot create candidates and Attack cannot confirm them", async () => {
    const scoped = await fixture("scope")
    const scope = createCodeGraphToolHandler({ environment: scoped.environment })
    await expect(scope.handle("code_finding", finding())).rejects.toThrow("Only Code Audit Hunt and Attack")
    await scope.close()

    const attacked = await fixture("attack")
    const attack = createCodeGraphToolHandler({ environment: attacked.environment })
    const candidate = (await attack.handle("code_finding", finding())) as { id: string }
    await expect(
      attack.handle("code_finding", {
        action: "transition",
        id: candidate.id,
        status: "confirmed",
        reason: "runtime effect observed",
      }),
    ).rejects.toThrow("Only Code Audit Verify")
    await attack.close()
  })
})
