// ── Changelog Release Notes ─────────────────────────────────────
// Extracts one exact version section so the immutable GitHub Release carries
// reviewed notes before GitHub appends its generated change list.
// → .github/workflows/release.yml — supplies the extracted body at draft creation.
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs"

export function extractReleaseNotes(markdown: string, version: string): string {
  const heading = `## ${version}`
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const start = lines.indexOf(heading)
  if (start < 0) throw new Error(`CHANGELOG.md does not contain ${heading}.`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim()
  if (!notes) throw new Error(`${heading} has no release notes.`)
  return notes
}

if (import.meta.main) {
  const [file, version] = process.argv.slice(2)
  if (!file || !version) throw new Error("Usage: bun scripts/release-notes.ts <changelog> <version>")
  process.stdout.write(extractReleaseNotes(fs.readFileSync(file, "utf8"), version))
}
