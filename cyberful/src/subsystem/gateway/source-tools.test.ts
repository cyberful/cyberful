// ── Read-Only Source Boundary Tests ──────────────────────────────
// Verifies containment, bounded source discovery, search, and workarea-only
// snapshot materialization for the phase gateway.
// → cyberful/src/subsystem/gateway/source-tools.ts — owns the tested source boundary.
// ─────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { handleSourceTool, sourceToolsAvailable } from "./source-tools"
import { isRecord } from "@/util/record"

let root = ""
let source = ""
let workarea = ""
let previousSource: string | undefined
let previousWorkarea: string | undefined

function recordValue(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} is not an object`)
  return value
}

function arrayValue(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} is not an array`)
  return value
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} is not a string`)
  return value
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-source-tools-"))
  source = path.join(root, "project")
  workarea = path.join(root, "workarea")
  await mkdir(path.join(source, "src"), { recursive: true })
  await mkdir(path.join(source, "node_modules", "ignored"), { recursive: true })
  await mkdir(path.join(source, ".git"), { recursive: true })
  await mkdir(workarea, { recursive: true })
  await writeFile(
    path.join(source, "src", "server.ts"),
    "export function run(input: string) {\n  return eval(input)\n}\n",
  )
  await writeFile(path.join(source, "robot.py"), "def command(value):\n    return value\n")
  await writeFile(path.join(source, "node_modules", "ignored", "index.js"), "eval('ignored')\n")
  await writeFile(path.join(source, ".git", "config"), "secret")
  await symlink(path.join(root, "outside.txt"), path.join(source, "outside-link"))
  await symlink(path.join(source, "src", "server.ts"), path.join(source, "server-link.ts"))
  await writeFile(path.join(root, "outside.txt"), "outside secret")
  previousSource = process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
  previousWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = source
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
})

afterEach(async () => {
  if (previousSource === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT = previousSource
  if (previousWorkarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previousWorkarea
  await rm(root, { recursive: true, force: true })
})

describe("source gateway tools", () => {
  test("inventory excludes dependency trees and symlinks", async () => {
    expect(sourceToolsAvailable()).toBe(true)
    const result = recordValue(await handleSourceTool("source_inventory", {}), "source inventory result")
    const files = arrayValue(result.files, "source inventory files").map((value) => {
      const file = recordValue(value, "source inventory file")
      return {
        path: stringValue(file.path, "source inventory path"),
        language: stringValue(file.language, "source inventory language"),
        sha256: stringValue(file.sha256, "source inventory digest"),
      }
    })
    expect(files.map((file) => file.path)).toEqual(["robot.py", "src/server.ts"])
    expect(files.find((file) => file.path === "src/server.ts")?.language).toBe("typescript")
    expect(files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
  })

  test("read and search stay beneath the authorized source", async () => {
    const read = recordValue(
      await handleSourceTool("source_read", { path: "src/server.ts", start_line: 2, end_line: 2 }),
      "source read result",
    )
    expect(read).toMatchObject({ text: "  return eval(input)", start_line: 2 })

    const search = recordValue(
      await handleSourceTool("source_search", { query: "eval(", max_results: 10 }),
      "source search result",
    )
    expect(search.results).toEqual([{ path: "src/server.ts", line: 2, text: "  return eval(input)" }])
    await expect(handleSourceTool("source_read", { path: "../outside.txt" })).rejects.toThrow("escapes")
    await expect(handleSourceTool("source_read", { path: "outside-link" })).rejects.toThrow("symlink")
    await expect(handleSourceTool("source_read", { path: "server-link.ts" })).rejects.toThrow("symlink")
    await expect(handleSourceTool("source_read", { path: ".git/config" })).rejects.toThrow("excluded")
    await expect(handleSourceTool("source_search", { query: "secret", prefix: ".git" })).rejects.toThrow("excluded")
  })

  test("snapshot copies source and writes a stable manifest only in the workarea", async () => {
    const snapshot = recordValue(await handleSourceTool("source_snapshot", {}), "source snapshot result")
    expect(snapshot).toMatchObject({ file_count: 2, manifest_path: "raw/source-snapshot/manifest.json" })
    expect(snapshot.source_root).toBeUndefined()
    expect(await readFile(path.join(workarea, "raw", "source-snapshot", "tree", "src", "server.ts"), "utf8")).toContain(
      "eval(input)",
    )
    const manifestPath = stringValue(snapshot.manifest_path, "source snapshot manifest path")
    const manifest = recordValue(
      JSON.parse(await readFile(path.join(workarea, manifestPath), "utf8")),
      "source snapshot manifest",
    )
    expect(manifest.source_root).toBe(await realpath(source))
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("snapshot rejects a symlinked raw directory instead of writing through it", async () => {
    const outside = path.join(root, "outside-output")
    await mkdir(outside)
    await symlink(outside, path.join(workarea, "raw"))
    await expect(handleSourceTool("source_snapshot", {})).rejects.toThrow("symlink")
    expect(await readdir(outside)).toEqual([])
  })
})
