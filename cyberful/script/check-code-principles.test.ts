// ── Code Canon Verification Contract Tests ──────────────────────
// Protects contributor-facing diagnostics for required headers, literate frames,
// unframed design notes, and forbidden explicit TypeScript `any` annotations.
// → cyberful/script/check-code-principles.ts — implements the repository gate.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { inspectCodeSource } from "./check-code-principles"

const validHeader = [
  "// ── Example Runtime Contract ──────────────────────────────────",
  "// Represents one repository-owned behavior used by the verifier fixture.",
  "// → cyberful/CODE.md — defines the source contract under test.",
  "// ─────────────────────────────────────────────────────────────────",
].join("\n")

describe("CODE.md verification", () => {
  test("accepts a current header and a substantive ornamental design note", () => {
    const source = [
      validHeader,
      "",
      "// ── Boundary Values Remain Canonical After Validation ───────────",
      "// External values enter through one decoder before reaching domain logic.",
      "// The internal representation excludes malformed and ambiguous variants.",
      "// Callers therefore consume one stable state rather than repeat checks.",
      "// A failed decode remains at the boundary that can render useful context.",
      "// ─────────────────────────────────────────────────────────────────",
      "export const value = 1",
      "",
    ].join("\n")

    expect(inspectCodeSource("cyberful/src/example.ts", source)).toEqual([])
  })

  test("rejects a missing file contract and an explicit any annotation", () => {
    const violations = inspectCodeSource(
      "cyberful/src/example.ts",
      "export function unsafe(value: any) { return value }\n",
    )

    expect(violations.map((violation) => violation.message)).toEqual([
      "missing ornamental file header",
      "explicit `any` is forbidden; validate or narrow `unknown`",
    ])
  })

  test("rejects underspecified frames and long unframed design prose", () => {
    const source = [
      validHeader,
      "",
      "// ── Incomplete Design Claim ─────────────────────────────────────",
      "// This line gives context.",
      "// This line names a decision.",
      "// This line names a consequence.",
      "// ─────────────────────────────────────────────────────────────────",
      "",
      "// This unframed note spans enough lines to represent design reasoning.",
      "// It would be easy for a future edit to detach it from the code it governs.",
      "// The complete ornamental form makes that design boundary reviewable.",
      "// The verifier must therefore reject this otherwise plausible prose block.",
      "export const value = 1",
      "",
    ].join("\n")
    const messages = inspectCodeSource("cyberful/src/example.ts", source).map((violation) => violation.message)

    expect(messages).toContain("literate prose has 3 substantive lines; expected 4–8")
    expect(messages).toContain("multi-line design note requires a complete ornamental frame")
  })

  test("rejects legacy field labels in the file header", () => {
    const source = `${validHeader.replace(
      "// Represents one repository-owned behavior used by the verifier fixture.",
      "// Owns: repository verification fixture.",
    )}
export const value = 1
`

    expect(inspectCodeSource("cyberful/src/example.ts", source).map((violation) => violation.message)).toContain(
      "use plain prose and `→`; Owns:/Connects: labels are forbidden",
    )
  })
})
