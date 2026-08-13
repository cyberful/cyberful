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
  createEvidenceManifest,
  ensureWorkareaDirectory,
  ensureWorkarea,
  listWorkareaFiles,
  normalizeWorkarea,
  readWorkareaFileChunk,
  readWorkareaImage,
  replaceWorkareaFile,
  verifyEvidenceManifest,
  workareaAbsolutePath,
  workareaDirectoryName,
  workareaProjectRoot,
  WorkareaToolError,
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

  test("reads large tool artifacts in bounded UTF-8 chunks without gaps and rejects symlinks", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-chunk-")))
    const content = `${"αβγ shell output\n".repeat(12_000)}tail`
    try {
      await replaceWorkareaFile(dir, "raw/tool-results/run/result.txt", content)
      const chunks: string[] = []
      let offset = 0
      do {
        const chunk = await readWorkareaFileChunk(dir, "raw/tool-results/run/result.txt", {
          offset,
          limit: 4_096,
        })
        expect(Buffer.byteLength(chunk.content)).toBeLessThanOrEqual(4_096)
        chunks.push(chunk.content)
        if (chunk.nextOffset === undefined) break
        expect(chunk.nextOffset).toBeGreaterThan(offset)
        offset = chunk.nextOffset
      } while (true)
      expect(chunks.join("")).toBe(content)

      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`)
      await writeFile(outside, "outside")
      await rm(path.join(dir, "raw", "tool-results", "run", "result.txt"))
      await symlink(outside, path.join(dir, "raw", "tool-results", "run", "result.txt"))
      await expect(readWorkareaFileChunk(dir, "raw/tool-results/run/result.txt")).rejects.toThrow("regular file")
      await rm(outside, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("discovers bounded regular files without traversing symlinks", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-list-")))
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`)
    try {
      await replaceWorkareaFile(dir, "raw/one.txt", "one")
      await replaceWorkareaFile(dir, "raw/nested/two.log", "two")
      await replaceWorkareaFile(dir, "raw/nested/three.txt", "three")
      await mkdir(outside)
      await writeFile(path.join(outside, "escaped.txt"), "escaped")
      await symlink(outside, path.join(dir, "raw", "linked"))

      expect(await listWorkareaFiles(dir, { prefix: "raw", pattern: "*.txt", maxDepth: 2 })).toEqual({
        files: [
          { path: "raw/nested/three.txt", size: 5 },
          { path: "raw/one.txt", size: 3 },
        ],
        truncated: false,
      })
      expect(await listWorkareaFiles(dir, { prefix: "raw", maxResults: 1 })).toMatchObject({
        files: [{ path: "raw/nested/three.txt" }],
        truncated: true,
      })
    } finally {
      await Promise.all([rm(dir, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })

  test("ignores atomic temporary entries that disappear during discovery", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-list-race-")))
    try {
      await replaceWorkareaFile(dir, "raw/stable.txt", "stable")
      await replaceWorkareaFile(dir, "raw/.cyberful-manifest.tmp", "temporary")

      const churn = Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const temporary = path.join(dir, "raw", `.cyberful-churn-${index}.tmp`)
          await writeFile(temporary, "temporary")
          await rm(temporary, { force: true })
        }),
      )
      const listings = Promise.all(
        Array.from({ length: 100 }, () => listWorkareaFiles(dir, { prefix: "raw", pattern: "*" })),
      )
      await churn

      for (const listing of await listings)
        expect(listing).toEqual({ files: [{ path: "raw/stable.txt", size: 6 }], truncated: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns typed discovery guidance for a missing artifact", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-missing-")))
    try {
      const error = await readWorkareaFileChunk(dir, "evidence/missing.png").catch((candidate) => candidate)
      expect(error).toBeInstanceOf(WorkareaToolError)
      expect((error as WorkareaToolError).toolError()).toEqual({
        code: "path_not_found",
        path: "evidence/missing.png",
        message: "Workarea file 'evidence/missing.png' does not exist.",
        recovery_call: {
          tool: "workarea_list",
          arguments: { prefix: "evidence", pattern: "missing.png", max_depth: 4, limit: 50 },
        },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reads bounded PNG evidence without a browser artifact namespace", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-workarea-image-")))
    try {
      const png = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
      png.writeUInt32BE(13, 8)
      png.write("IHDR", 12, "ascii")
      png.writeUInt32BE(320, 16)
      png.writeUInt32BE(200, 20)
      await replaceWorkareaFile(dir, "evidence/render.png", png)

      expect(await readWorkareaImage(dir, "evidence/render.png")).toMatchObject({
        mimeType: "image/png",
        bytes: 24,
        width: 320,
        height: 200,
      })
      await replaceWorkareaFile(dir, "evidence/not-image.txt", "plain text")
      const error = await readWorkareaImage(dir, "evidence/not-image.txt").catch((candidate) => candidate)
      expect(error).toBeInstanceOf(WorkareaToolError)
      expect((error as WorkareaToolError).code).toBe("unsupported_image")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates stable self-excluding manifests and detects file-set or digest changes", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cyberful-evidence-manifest-")))
    try {
      await replaceWorkareaFile(dir, "evidence/b.txt", "bravo")
      await replaceWorkareaFile(dir, "evidence/a.txt", "alpha")
      await replaceWorkareaFile(dir, "evidence/Z.txt", "zulu")
      await replaceWorkareaFile(dir, "evidence/ignored.tmp", "temporary")

      const first = await createEvidenceManifest(dir, "evidence")
      const content = await readFile(path.join(dir, first.path), "utf8")
      expect(content.split("\n").filter(Boolean).map((line) => line.slice(66))).toEqual(["Z.txt", "a.txt", "b.txt"])
      expect(content).not.toContain("EVIDENCE.sha256")
      expect(await createEvidenceManifest(dir, "evidence")).toEqual(first)
      expect(await verifyEvidenceManifest(dir, "evidence")).toEqual({
        path: "evidence/EVIDENCE.sha256",
        valid: true,
        files: 3,
      })

      await replaceWorkareaFile(dir, "evidence/a.txt", "changed")
      expect(await verifyEvidenceManifest(dir, "evidence")).toMatchObject({
        valid: false,
        reason: "digest_mismatch",
        file: "a.txt",
        digest_mismatches: ["a.txt"],
      })
      await replaceWorkareaFile(dir, "evidence/c.txt", "charlie")
      expect(await verifyEvidenceManifest(dir, "evidence")).toMatchObject({
        valid: false,
        reason: "file_set_mismatch",
        missing: [],
        unexpected: ["c.txt"],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
