// ── ZAP Autonomy Contract Tests ─────────────────────────────────
// Verifies the reusable skill exposes the engagement runtime without adding
//   phase, category, retry, or traffic restrictions beyond the mission.
// → cyberful/builtin/skills/ZAP.md — defines the shared workflow under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

describe("built-in ZAP MCP skill", () => {
  const read = () => readFile(path.join(Builtin.DIR, "skills", "ZAP.md"), "utf8")

  test("exposes the complete engagement-owned capability under mission authority", async () => {
    const skill = await read()
    expect(skill).toMatch(/^---\nname: ZAP\n/)
    expect(skill).toMatch(/browser capture, history, replay, scanning, WebSocket evidence, OAST, and reports/i)
    expect(skill).toMatch(/no ZAP-specific traffic or category restriction/i)
    expect(skill).toMatch(/alerts as leads/i)
    expect(skill).toMatch(/reproducible effect and control/i)
  })

  test("does not introduce phase gates or HTTP-response retry policy", async () => {
    const skill = await read()
    expect(skill).not.toMatch(/defer|blocked|approval gate|scoped report|required phase/i)
    expect(skill).not.toMatch(/403|429|WAF|managed challenge|retry/i)
  })
})
