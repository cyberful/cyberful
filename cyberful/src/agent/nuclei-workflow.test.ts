// ── Nuclei Workflow Contract Test ────────────────────────────────
// Verifies that the shipped Nuclei skill teaches scoped execution, capability
// checks, finding states, authorization markers, and routine rate limits.
// → cyberful/builtin/skills/NUCLEI.md — contains the user-facing workflow under test.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

test("the Nuclei skill teaches both new controls and the existing expert tools", async () => {
  const skill = await readFile(path.join(Builtin.DIR, "skills", "NUCLEI.md"), "utf8")

  expect(skill).toContain("`nuclei_plan`")
  expect(skill).toContain("`nuclei_run_scoped`")
  expect(skill).toContain("`nuclei_templates`")
  expect(skill).toContain("`nuclei`")
  expect(skill).toContain("`tool_inventory`")
  expect(skill).toContain("`capability_attestation`")
  expect(skill).toContain("SUSPECTED")
  expect(skill).toContain("X-Request-ID: Bugcrowd")
  expect(skill).toContain("5 requests/second")
})
