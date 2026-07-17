// ── Relative Config Entry Naming ─────────────────────────────────
// Converts a scanned config path into its extension-free command or agent name,
// stripping only an allowed prefix anchored at the start of the relative path.
// → cyberful/src/config/agent.ts — names discovered agent definitions.
// → cyberful/src/config/command.ts — names discovered command definitions.
// ─────────────────────────────────────────────────────────────────

import path from "path"

// ── Prefixes Match Only The Scanned Relative Root ─────────────────
// Callers first make each discovered path relative to the directory they scanned.
// Prefix removal can then be anchored at the first segment instead of matching an
// arbitrary substring in an absolute parent path. This prevents a home or workspace
// directory named `agent` or `command` from silently changing the configured key,
// while preserving nested entry names below the actual config folder.
// ─────────────────────────────────────────────────────────────────
function stripPrefix(relativePath: string, prefixes: string[]) {
  const normalized = relativePath.replaceAll("\\", "/")
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  }
}

export function configEntryNameFromPath(relativePath: string, prefixes: string[]) {
  const candidate = stripPrefix(relativePath, prefixes) ?? path.basename(relativePath)
  const ext = path.extname(candidate)
  return ext.length ? candidate.slice(0, -ext.length) : candidate
}
