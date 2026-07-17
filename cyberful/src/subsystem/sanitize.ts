// ── Workarea Markdown Sanitization ──────────────────────────────
// Normalizes typographic confusables in generated Markdown while refusing
// symlink traversal and preserving every non-Markdown engagement artifact.
// → cyberful/src/subsystem/phase-runner.ts — invokes cleanup after a phase run.
// ─────────────────────────────────────────────────────────────────

import fs from "fs/promises"
import path from "path"
import { deTypography } from "../util/typography"

const MARKDOWN = /\.(md|markdown)$/i
const SANITIZE_CONCURRENCY = 32

export async function sanitizeMarkdownTree(root: string): Promise<void> {
  const directories = [root]
  while (directories.length > 0) {
    const directoryBatch = directories.splice(0, SANITIZE_CONCURRENCY)
    const listings = await Promise.all(
      directoryBatch.map(async (directory) => ({
        directory,
        entries: await fs.readdir(directory, { withFileTypes: true }),
      })),
    )
    const markdown: string[] = []
    for (const listing of listings) {
      for (const entry of listing.entries) {
        const file = path.join(listing.directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          directories.push(file)
          continue
        }
        if (entry.isFile() && MARKDOWN.test(entry.name)) markdown.push(file)
      }
    }
    for (let offset = 0; offset < markdown.length; offset += SANITIZE_CONCURRENCY) {
      await Promise.all(
        markdown.slice(offset, offset + SANITIZE_CONCURRENCY).map(async (file) => {
          const before = await fs.readFile(file, "utf8")
          const after = deTypography(before)
          if (after !== before) await fs.writeFile(file, after)
        }),
      )
    }
  }
}

export * as SubsystemSanitize from "./sanitize"
