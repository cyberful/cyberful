// ── Browser Download Artifact Contract ────────────────────────────
// Exercises the path and size boundaries users rely on when a page downloads
// evidence. A browser filename cannot escape the artifacts directory, complete
// content is preserved, and oversized content is rejected without a partial
// artifact or temporary file surviving the failed operation.
// → mcps/browser/browser_download.mjs — implements bounded artifact writes.
// ──────────────────────────────────────────────────────────────────

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { describe, expect, test } from "bun:test"
import { saveBrowserDownload } from "./browser_download.mjs"

async function withArtifacts(run) {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-download-"))
  try {
    await run(artifactsDir)
  } finally {
    await rm(artifactsDir, { force: true, recursive: true })
  }
}

function download(name, chunks) {
  return {
    suggestedFilename: () => name,
    createReadStream: async () => Readable.from(chunks),
  }
}

describe("browser download artifacts", () => {
  test("confines the browser filename and saves complete content", async () => {
    await withArtifacts(async (artifactsDir) => {
      const result = await saveBrowserDownload(download("../../evidence.txt", ["daily evidence"]), {
        artifactsDir,
        maxBytes: 100,
        timeoutMs: 1000,
      })

      expect(result.target).toBe(path.join(artifactsDir, "evidence.txt"))
      expect(await readFile(result.target, "utf8")).toBe("daily evidence")
      expect(await readdir(artifactsDir)).toEqual(["evidence.txt"])
    })
  })

  test("removes partial output when a download exceeds its limit", async () => {
    await withArtifacts(async (artifactsDir) => {
      const operation = saveBrowserDownload(download("large.bin", [Buffer.alloc(6)]), {
        artifactsDir,
        maxBytes: 5,
        timeoutMs: 1000,
      })

      await expect(operation).rejects.toThrow("exceeded the 5-byte artifact limit")
      expect(await readdir(artifactsDir)).toEqual([])
    })
  })
})
