// ── Tool Output Preview Tests ────────────────────────────────────
// Protects the daily result-card experience by checking head and tail previews,
//   UTF-8 byte accounting, and finite fallback behavior without writing artifacts.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { buildTruncatedPreview } from "./truncate"

describe("tool output previews", () => {
  test("keeps the requested side of a line-limited result", () => {
    const text = "one\ntwo\nthree"
    expect(buildTruncatedPreview(text, { maxLines: 2, maxBytes: 100, direction: "head" })).toEqual({
      preview: "one\ntwo",
      removed: 1,
      unit: "lines",
    })
    expect(buildTruncatedPreview(text, { maxLines: 2, maxBytes: 100, direction: "tail" })).toEqual({
      preview: "two\nthree",
      removed: 1,
      unit: "lines",
    })
  })

  test("counts UTF-8 bytes rather than JavaScript character width", () => {
    expect(buildTruncatedPreview("éé\nnext", { maxLines: 10, maxBytes: 4, direction: "head" })).toEqual({
      preview: "éé",
      removed: 5,
      unit: "bytes",
    })
  })

  test("uses finite defaults when a programmatic limit is invalid", () => {
    const text = Array.from({ length: 501 }, (_, index) => String(index)).join("\n")
    expect(
      buildTruncatedPreview(text, { maxLines: 0, maxBytes: Number.POSITIVE_INFINITY, direction: "head" })?.unit,
    ).toBe("lines")
  })
})
