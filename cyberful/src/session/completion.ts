// ── Completion Artifact Validation ─────────────────────────────────────────
// Canonicalizes reported artifacts and admits only regular files contained in the workarea.
// → cyberful/src/subsystem/completion.ts — validates portable relative artifact paths.
// ──────────────────────────────────────────────────────────────────────

import path from "path"
import { lstat, realpath } from "node:fs/promises"
import { lookup } from "mime-types"
import { SubsystemCompletion } from "@/subsystem/completion"
import type { MessageV2 } from "./message-v2"

export interface ArtifactCandidate {
  label: string
  path: string
  mime?: string
  primary?: boolean
}

function isMissing(error: unknown): error is { code: "ENOENT" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function optionalPath<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function validateArtifacts(root: string, candidates: readonly ArtifactCandidate[]) {
  const canonicalRoot = await optionalPath(realpath(root))
  if (!canonicalRoot) return []
  const seen = new Set<string>()
  const results: MessageV2.CompletionArtifact[] = []

  for (const candidate of candidates) {
    const relative = SubsystemCompletion.safeRelativeArtifactPath(candidate.path)
    if (!relative || seen.has(relative) || results.length >= 5) continue
    const target = path.resolve(canonicalRoot, relative)
    const relation = path.relative(canonicalRoot, target)
    if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) continue
    const info = await optionalPath(lstat(target))
    if (!info?.isFile() || info.isSymbolicLink()) continue
    const resolved = await optionalPath(realpath(target))
    if (!resolved) continue
    const resolvedRelation = path.relative(canonicalRoot, resolved)
    if (resolvedRelation.startsWith("..") || path.isAbsolute(resolvedRelation)) continue
    seen.add(relative)
    results.push({
      label: (candidate.label.trim() || path.basename(relative)).slice(0, 80),
      path: relative,
      mime: candidate.mime ?? (lookup(relative) || "application/octet-stream"),
      ...(candidate.primary ? { primary: true } : {}),
    })
  }
  return results
}

export * as SessionCompletion from "./completion"
