// ── Changelog Release Notes Tests ───────────────────────────────
// Ensures immutable GitHub Releases receive only the reviewed notes for their
// exact version, including the required 0.4.0 wire-compatibility warning.
// → scripts/release-notes.ts — owns deterministic section extraction.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { extractReleaseNotes } from "../../scripts/release-notes"

describe("release notes", () => {
  test("extracts one exact changelog section", () => {
    const notes = extractReleaseNotes("# Changelog\n\n## 2.0.0\n\n- Breaking.\n\n## 1.0.0\n\n- First.\n", "2.0.0")
    expect(notes).toBe("- Breaking.")
  })

  test("the 0.4.0 notes declare the observation wire breaking change", () => {
    const changelog = fs.readFileSync(path.resolve(import.meta.dir, "../..", "CHANGELOG.md"), "utf8")
    const notes = extractReleaseNotes(changelog, "0.4.0")
    expect(notes).toContain("breaking")
    expect(notes).toContain("CyberfulObservationV1")
    expect(notes).toContain("Outcome exit codes are unchanged")
  })

  test("rejects missing and empty sections", () => {
    expect(() => extractReleaseNotes("# Changelog\n", "1.0.0")).toThrow("does not contain")
    expect(() => extractReleaseNotes("# Changelog\n\n## 1.0.0\n", "1.0.0")).toThrow("has no release notes")
  })
})
