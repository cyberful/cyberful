// ── Owned Markdown Artifact Sanitization ─────────────────────────
// Normalizes typographic confusables only in Markdown artifacts explicitly
// owned by the completed phase; repository and prior-phase data stay untouched.
// → cyberful/src/subsystem/phase-runner.ts — invokes cleanup after a phase run.
// ─────────────────────────────────────────────────────────────────

import { lstat, readFile, realpath, writeFile } from "fs/promises"
import path from "path"
import { deTypography } from "../util/typography"

const MARKDOWN = /\.(md|markdown)$/i

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function ownedMarkdown(root: string, artifact: string) {
  if (!artifact || path.isAbsolute(artifact) || !MARKDOWN.test(artifact))
    throw new Error(`Markdown artifact '${artifact}' is not a safe relative Markdown path`)
  const normalized = path.normalize(artifact)
  if (normalized.split(path.sep).some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error(`Markdown artifact '${artifact}' escapes its phase workarea`)
  const candidate = path.resolve(root, normalized)
  if (!contained(root, candidate)) throw new Error(`Markdown artifact '${artifact}' escapes its phase workarea`)
  let current = root
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!metadata) return
    if (metadata.isSymbolicLink()) throw new Error(`Markdown artifact '${artifact}' traverses a symlink`)
  }
  const metadata = await lstat(candidate)
  if (!metadata.isFile()) throw new Error(`Markdown artifact '${artifact}' is not a regular file`)
  const canonical = await realpath(candidate)
  if (!contained(root, canonical)) throw new Error(`Markdown artifact '${artifact}' resolves outside its workarea`)
  return canonical
}

export async function sanitizeMarkdownArtifacts(root: string, artifacts: readonly string[]): Promise<void> {
  const canonicalRoot = await realpath(root)
  await Promise.all(
    [...new Set(artifacts)].map(async (artifact) => {
      const file = await ownedMarkdown(canonicalRoot, artifact)
      if (!file) return
      const before = await readFile(file, "utf8")
      const after = deTypography(before)
      if (after !== before) await writeFile(file, after)
    }),
  )
}

export * as SubsystemSanitize from "./sanitize"
