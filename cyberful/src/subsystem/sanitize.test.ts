// ── Workarea Markdown Sanitization Test ─────────────────────────
// Verifies that routine generated Markdown is normalized recursively while
// payload files and paths reachable only through symlinks remain untouched.
// → cyberful/src/subsystem/sanitize.ts — performs the bounded traversal.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { sanitizeMarkdownTree } from "./sanitize"

describe("Codex Markdown sanitization", () => {
  test("folds Markdown under cwd, leaves payload files and symlink targets untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-sanitize-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "expert-outside-"))
    try {
      await fs.mkdir(path.join(root, "nested"))
      await fs.writeFile(path.join(root, "nested", "REPORT.md"), "Recon → exploit — done")
      await fs.writeFile(path.join(root, "payload.txt"), "keep — unicode")
      await fs.writeFile(path.join(outside, "OUTSIDE.md"), "outside — unchanged")
      await fs.symlink(outside, path.join(root, "linked"))

      await sanitizeMarkdownTree(root)

      expect(await fs.readFile(path.join(root, "nested", "REPORT.md"), "utf8")).toBe("Recon -> exploit - done")
      expect(await fs.readFile(path.join(root, "payload.txt"), "utf8")).toBe("keep — unicode")
      expect(await fs.readFile(path.join(outside, "OUTSIDE.md"), "utf8")).toBe("outside — unchanged")
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ])
    }
  })

  test("sanitizes every file across more than one bounded directory batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-sanitize-volume-"))
    try {
      for (let index = 0; index < 40; index += 1) {
        const directory = path.join(root, `part-${index}`)
        await fs.mkdir(directory)
        await fs.writeFile(path.join(directory, "REPORT.md"), `Part ${index} — ready`)
      }

      await sanitizeMarkdownTree(root)

      for (let index = 0; index < 40; index += 1) {
        expect(await fs.readFile(path.join(root, `part-${index}`, "REPORT.md"), "utf8")).toBe(`Part ${index} - ready`)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
