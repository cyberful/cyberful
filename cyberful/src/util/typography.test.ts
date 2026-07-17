// ── Markdown Typography Boundary Tests ───────────────────────────
// Protects everyday report editing by folding only confusable punctuation while
// preserving meaningful Unicode and exact bytes in non-Markdown artifacts.
// → cyberful/src/util/typography.ts — implements the normalization under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { deTypography, isMarkdownPath } from "./typography"

describe("deTypography", () => {
  test("folds the dashes an authoring model emits that the exact-match editor can't reproduce", () => {
    // The observed failure: an em dash in the file, a hyphen in the editor's old text.
    expect(deTypography("S1 — cross-tenant, reward $6.5–7.5k")).toBe("S1 - cross-tenant, reward $6.5-7.5k")
  })

  test("expands arrows and ellipsis a small model tends to ASCII-ify", () => {
    expect(deTypography("recon → exploit ↔ verify … done ← back")).toBe("recon -> exploit <-> verify ... done <- back")
  })

  test("folds smart quotes and non-breaking spaces", () => {
    expect(deTypography("say “yes” to ’em now")).toBe('say "yes" to \'em now')
  })

  test("leaves distinctive, non-confusable code points untouched", () => {
    // These read as themselves; the model copies them verbatim, so they never break a match, and
    // stripping them could destroy meaning. Only confusables are folded.
    const kept = "§6 ✅ done ¹ note ≥ ≠ 日本"
    expect(deTypography(kept)).toBe(kept)
  })

  test("is a no-op on already-plain ASCII", () => {
    const ascii = "plain - text -> ok"
    expect(deTypography(ascii)).toBe(ascii)
  })
})

describe("isMarkdownPath", () => {
  test("matches .md and .markdown case-insensitively", () => {
    expect(isMarkdownPath("/w/RECON.md")).toBe(true)
    expect(isMarkdownPath("/w/notes.MARKDOWN")).toBe(true)
  })

  test("excludes payload/PoC/data files so their exact bytes are preserved", () => {
    expect(isMarkdownPath("/w/exploit.py")).toBe(false)
    expect(isMarkdownPath("/w/words.txt")).toBe(false)
    expect(isMarkdownPath("/w/data.json")).toBe(false)
  })
})
