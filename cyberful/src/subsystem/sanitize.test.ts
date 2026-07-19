// ── Owned Markdown Artifact Sanitization Test ────────────────────
// Verifies that only explicitly declared phase output is normalized while
// repository data, prior artifacts, payloads, and symlink targets are untouched.
// → cyberful/src/subsystem/sanitize.ts — enforces artifact ownership.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { sanitizeMarkdownArtifacts } from "./sanitize"

describe("Codex Markdown sanitization", () => {
  test("folds only the declared phase Markdown artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-sanitize-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "expert-outside-"))
    try {
      await fs.mkdir(path.join(root, "nested"))
      await fs.writeFile(path.join(root, "nested", "REPORT.md"), "Recon → exploit — done")
      await fs.writeFile(path.join(root, "AGENTS.md"), "Repository — data")
      await fs.writeFile(path.join(root, "PRIOR.md"), "Prior — artifact")
      await fs.writeFile(path.join(root, "payload.txt"), "keep — unicode")
      await fs.writeFile(path.join(outside, "OUTSIDE.md"), "outside — unchanged")
      await fs.symlink(outside, path.join(root, "linked"))

      await sanitizeMarkdownArtifacts(root, ["nested/REPORT.md"])

      expect(await fs.readFile(path.join(root, "nested", "REPORT.md"), "utf8")).toBe("Recon -> exploit - done")
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Repository — data")
      expect(await fs.readFile(path.join(root, "PRIOR.md"), "utf8")).toBe("Prior — artifact")
      expect(await fs.readFile(path.join(root, "payload.txt"), "utf8")).toBe("keep — unicode")
      expect(await fs.readFile(path.join(outside, "OUTSIDE.md"), "utf8")).toBe("outside — unchanged")
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects escapes and symlinked artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-sanitize-boundary-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "expert-sanitize-boundary-outside-"))
    try {
      await fs.writeFile(path.join(outside, "REPORT.md"), "Outside — unchanged")
      await fs.symlink(outside, path.join(root, "linked"))
      await expect(sanitizeMarkdownArtifacts(root, ["../REPORT.md"])).rejects.toThrow("escapes")
      await expect(sanitizeMarkdownArtifacts(root, ["linked/REPORT.md"])).rejects.toThrow("symlink")
      expect(await fs.readFile(path.join(outside, "REPORT.md"), "utf8")).toBe("Outside — unchanged")
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})
