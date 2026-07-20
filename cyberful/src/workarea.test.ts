// ── Canonical Workarea Boundary Tests ────────────────────────────
// Verifies workarea naming, plain-directory creation, and rejection of
//   filesystem links that could redirect workflow artifacts outside a project.
// → cyberful/src/workarea.ts — owns the workarea trust boundary under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "path"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import {
  ensureWorkareaDirectory,
  ensureWorkarea,
  normalizeWorkarea,
  replaceWorkareaFile,
  workareaAbsolutePath,
  workareaDirectoryName,
  workareaProjectRoot,
} from "./workarea"

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

describe("workarea", () => {
  test("normalizes display names and slugifies directory names", () => {
    expect(normalizeWorkarea("  LexRoom.ai  ")).toBe("LexRoom.ai")
    expect(workareaDirectoryName("LexRoom.ai")).toBe("lexroom.ai")
    expect(workareaDirectoryName("Client Alpha")).toBe("client-alpha")
  })

  test("rejects traversal and path separators", () => {
    expect(() => workareaDirectoryName("../lexroom")).toThrow("Workarea cannot contain")
    expect(() => workareaDirectoryName("lexroom/ai")).toThrow("Workarea cannot contain")
    expect(() => workareaDirectoryName("lexroom\\ai")).toThrow("Workarea cannot contain")
  })

  test("uses one project root for saving and restoring the latest workarea", () => {
    expect(workareaProjectRoot({ directory: "/project", worktree: "/worktree", fallback: "/fallback" })).toBe(
      "/project",
    )
    expect(workareaProjectRoot({ directory: undefined, worktree: "/worktree", fallback: "/fallback" })).toBe(
      "/worktree",
    )
    expect(workareaProjectRoot({ directory: undefined, worktree: undefined, fallback: "/fallback" })).toBe("/fallback")
  })

  test("creates the workarea directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyberful-workarea-"))
    try {
      const canonical = await ensureWorkarea(dir, "LexRoom.ai")
      expect((await stat(workareaAbsolutePath(dir, "LexRoom.ai"))).isDirectory()).toBe(true)
      expect(canonical).toBe(await realpath(workareaAbsolutePath(dir, "LexRoom.ai")))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not create a workarea through a symlinked work directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyberful-workarea-parent-link-"))
    const project = path.join(dir, "project")
    const outside = path.join(dir, "outside")
    try {
      await Promise.all([mkdir(project), mkdir(outside)])
      await symlink(outside, path.join(project, "work"))

      await expect(ensureWorkarea(project, "client")).rejects.toThrow("plain directory")
      expect(await pathExists(path.join(outside, "client"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not reuse a symlink in place of the selected workarea", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyberful-workarea-leaf-link-"))
    const project = path.join(dir, "project")
    const outside = path.join(dir, "outside")
    try {
      await Promise.all([mkdir(path.join(project, "work"), { recursive: true }), mkdir(outside)])
      await symlink(outside, path.join(project, "work", "client"))

      await expect(ensureWorkarea(project, "client")).rejects.toThrow("plain directory")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates only plain contained child directories beneath a canonical workarea", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-child-")))
    try {
      const child = await ensureWorkareaDirectory(dir, "raw/code-graph")
      expect(child).toBe(await realpath(path.join(dir, "raw", "code-graph")))
      await expect(ensureWorkareaDirectory(dir, "../outside")).rejects.toThrow("relative")
      await expect(ensureWorkareaDirectory(dir, "/outside")).rejects.toThrow("relative")

      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`)
      await mkdir(outside)
      try {
        await symlink(outside, path.join(dir, "inputs"))
        await expect(ensureWorkareaDirectory(dir, "inputs/uploads")).rejects.toThrow("plain directory")
        expect(await pathExists(path.join(outside, "uploads"))).toBe(false)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("atomically replaces regular workarea files without following a leaf symlink", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-file-")))
    try {
      await writeFile(path.join(dir, "MISSION.md"), "old")
      const destination = await replaceWorkareaFile(dir, "MISSION.md", "new")
      expect(destination).toBe(path.join(dir, "MISSION.md"))
      expect(await readFile(destination, "utf8")).toBe("new")
      expect((await readdir(dir)).filter((entry) => entry.startsWith(".cyberful-"))).toEqual([])

      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`)
      await writeFile(outside, "outside")
      try {
        await rm(destination)
        await symlink(outside, destination)
        await expect(replaceWorkareaFile(dir, "MISSION.md", "escaped")).rejects.toThrow("not a link")
        expect(await readFile(outside, "utf8")).toBe("outside")
      } finally {
        await rm(outside, { force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a symlinked parent before replacing a nested workarea file", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-file-parent-")))
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`)
    try {
      await mkdir(outside)
      await symlink(outside, path.join(dir, "inputs"))
      await expect(replaceWorkareaFile(dir, "inputs/request.txt", "secret")).rejects.toThrow("plain directory")
      expect(await pathExists(path.join(outside, "request.txt"))).toBe(false)
    } finally {
      await Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })
})
