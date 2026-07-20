// ── Disposable Code Audit Lab Tests ─────────────────────────────
// Exercises phase gating, source materialization, evidence, and cleanup without
// requiring Docker by selecting the explicit no-bootstrap path.
// → cyberful/src/subsystem/gateway/audit-lab.ts — owns the tested lifecycle.
// ────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { auditLabAvailable, cleanupAuditLabs, prepareAuditLab } from "./audit-lab"

const roots: string[] = []
const original = { ...process.env }

async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function fixture(phase = "attack") {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-audit-lab-"))
  roots.push(root)
  const source = path.join(root, "source")
  const workarea = path.join(root, "workarea")
  const sourceStore = path.join(root, "source-store")
  await mkdir(path.join(source, "service"), { recursive: true })
  await mkdir(workarea)
  await mkdir(path.join(sourceStore, "import"), { recursive: true })
  await writeFile(path.join(source, "service", "app.ts"), "export const secret = userInput\n")
  await writeFile(path.join(source, "service", "package.json"), '{"name":"service","version":"1.0.0"}\n')
  process.env.CYBERFUL_SUBSYSTEM_WORKFLOW = "code-audit"
  process.env.CYBERFUL_SUBSYSTEM_PHASE = phase
  process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = source
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBERFUL_SOURCE_STORE_ROOT = sourceStore
  return { source, workarea }
}

afterEach(async () => {
  await cleanupAuditLabs().catch(() => undefined)
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Code Audit lab", () => {
  test("materializes a component without mutating source and removes it on cleanup", async () => {
    const { source, workarea } = await fixture()
    expect(auditLabAvailable()).toBe(true)
    const result = await prepareAuditLab({ path: "service", bootstrap: "none" })
    expect(result.container_path).toBe("/workspace/.cyberful-lab/attack")
    expect(result.bootstrap).toEqual([])
    expect(result.isolation).toMatchObject({
      checkout_mutated: false,
      source_visible_during_network: false,
      host_credentials_mounted: false,
      runtime_network: "none",
    })
    const labFile = path.join(workarea, ".cyberful-lab", "attack", "app.ts")
    expect(await readFile(labFile, "utf8")).toContain("userInput")
    expect(await readFile(path.join(source, "service", "app.ts"), "utf8")).toContain("userInput")
    expect(await exists(path.join(workarea, "raw", "code-audit", "attack", "lab.json"))).toBe(true)
    await cleanupAuditLabs()
    expect(await exists(path.join(workarea, ".cyberful-lab", "attack"))).toBe(false)
  })

  test("rejects every phase except Attack and Verify", async () => {
    await fixture("hunt")
    await expect(prepareAuditLab({ bootstrap: "none" })).rejects.toThrow("Attack and Verify")
  })
})
