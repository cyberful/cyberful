// ── Report Compliance Contract Tests ─────────────────────────────
// Verifies audit-ready report sections, control mappings, and honesty constraints
// in the terminal report persona shipped to users.
// → cyberful/builtin/agents/pentest/report.md — supplies the report contract under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

// ── Compliance Claims Stay Evidence-Bound ─────────────────────────
// The report persona is the only runtime owner of the SOC 2 and ISO 27001 mapping,
// so tests inspect the shipped artifact rather than duplicate its full structure.
// Stable audit anchors catch accidental removal, while narrow negative assertions
// prevent the persona from turning engagement evidence into a certification claim.
// This is a content contract that static TypeScript checks cannot establish.
// ─────────────────────────────────────────────────────────────────
describe("audit-ready report contract", () => {
  const read = (rel: string) => readFile(path.join(Builtin.DIR, rel), "utf8")

  // These are substring anchors rather than a second copy of the report structure.
  const anchors = ["Audit-ready", "Document Control", "Control mapping", "SOC 2", "ISO 27001", "Attestation"]

  // ── Negative Patterns Exclude Legitimate Caveats ────────────────
  // Report prose must discuss compliance while denying that a pentest certifies it.
  // Broad fragments such as `compl` would therefore reject the required disclaimer.
  // These expressions match only affirmative compliance or certification claims,
  // keeping the test sensitive to overreach without freezing acceptable wording.
  // ─────────────────────────────────────────────────────────────────
  const overClaims = [
    /\bis compliant with\b/i,
    /\b(SOC ?2|ISO ?27001)[- ]certified\b/i,
    /\bcertifies compliance\b/i,
    /\bfully compliant\b/i,
  ]

  test("the report persona carries the audit sections, honesty caveat, and mapping reference", async () => {
    const text = await read("agents/pentest/report.md")
    for (const anchor of anchors) {
      expect(text, `report persona must mention "${anchor}"`).toContain(anchor)
    }
    expect(text, "report persona must state it is evidence, not a compliance verdict").toMatch(
      /not a compliance (audit|certification)|not a certification|evidence (toward|relevant)/i,
    )
    for (const id of ["CC6.1", "CC7.1", "A.8.8"]) {
      expect(text, `report persona must inline control id "${id}"`).toContain(id)
    }
    expect(text, "report persona must inline the coverage-matrix footnote").toMatch(/point-in-time engagement/i)
  })

  test("the report persona makes no compliance/certification over-claim", async () => {
    const text = await read("agents/pentest/report.md")
    for (const bad of overClaims) {
      expect(text, `report persona must not over-claim: ${bad}`).not.toMatch(bad)
    }
  })
})
