// ── Nuclei Autonomy Contract Test ───────────────────────────────
// Verifies the shipped skill exposes the complete CLI, keeps preview optional,
//   and introduces no scanner-specific limits beyond update-check suppression.
// → cyberful/builtin/skills/nuclei/SKILL.md — contains the workflow under test.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

test("the Nuclei skill preserves caller-controlled scan capability", async () => {
  const skill = await readFile(path.join(Builtin.DIR, "skills", "nuclei", "SKILL.md"), "utf8")

  expect(skill).toContain("`nuclei`")
  expect(skill).toContain("`nuclei_templates`")
  expect(skill).toMatch(/complete CLI/i)
  expect(skill).toMatch(/optional offline/i)
  expect(skill).toContain("`-disable-update-check`")
  expect(skill).not.toMatch(/nuclei_(plan|run_scoped)/)
  expect(skill).not.toMatch(/\b(maximum|approval gate|must precede|fixed rate|hard cap)\b/i)
})
