// ── ZAP Autonomy Contract Tests ─────────────────────────────────
// Verifies the reusable skill exposes the engagement runtime without adding
//   phase, category, retry, or traffic restrictions beyond the mission.
// → cyberful/builtin/skills/zap/SKILL.md — defines the shared workflow under test.
// → cyberful/builtin/agents/pentest/verify.md — activates ZAP for independent retesting.
// → cyberful/builtin/agents/pentest/report.md — invokes the final evidence snapshot.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

describe("built-in ZAP MCP skill", () => {
  const read = () => readFile(path.join(Builtin.DIR, "skills", "zap", "SKILL.md"), "utf8")
  const readPentestPersona = (name: "verify" | "report") =>
    readFile(path.join(Builtin.DIR, "agents", "pentest", `${name}.md`), "utf8")

  test("exposes the complete engagement-owned capability under mission authority", async () => {
    const skill = await read()
    expect(skill).toMatch(/^---\nname: ZAP\n/)
    expect(skill).toMatch(/browser capture, history, replay, scanning, WebSocket evidence, OAST, and reports/i)
    expect(skill).toMatch(/no ZAP-specific traffic or category restriction/i)
    expect(skill).toMatch(/alerts as leads/i)
    expect(skill).toMatch(/reproducible effect and control/i)
  })

  test("owns selective history replay and exact raw-request handling", async () => {
    const skill = await read()
    expect(skill).toMatch(/`zap_history_search`[\s\S]*metadata-only by default/i)
    expect(skill).toMatch(/`zap_history_get`[\s\S]*`include_bodies: true`/i)
    expect(skill).toMatch(/Prefer `zap_history_replay`/i)
    expect(skill).toMatch(/captured cookies and authorization headers inside ZAP/i)
    expect(skill).toMatch(/`zap_http_request`[\s\S]*exact raw request/i)
    expect(skill).toMatch(/origin-form request line[\s\S]*exact absolute HTTP\(S\) destination as `target_url`/i)
  })

  test("defines a traffic-free final engagement snapshot", async () => {
    const skill = await read()
    expect(skill).toContain("## Final engagement snapshot")
    expect(skill).toMatch(/ZAP as a local evidence source[\s\S]*Do not navigate, replay, spider, start a scan/i)
    expect(skill).toContain("`zap_get_passive_scan_status`")
    expect(skill).toContain("`zap_generate_workarea_report`")
    expect(skill).toContain('`file_path: "raw/zap/final-report.json"`')
    expect(skill).toContain('`template: "traditional-json"`')
  })

  test("is activated by exact catalog name while personas retain phase policy", async () => {
    const [verify, report] = await Promise.all([readPentestPersona("verify"), readPentestPersona("report")])
    expect(verify).toMatch(/Before using a `zap_\*` tool or `zap:\/\/` resource, load and follow the builtin `ZAP` skill/)
    expect(verify).not.toMatch(/zap_history_search|zap_history_get|zap_history_replay|zap_http_request/)
    expect(report).toMatch(/builtin `ZAP` skill, including its \*\*Final engagement snapshot\*\* procedure/)
    expect(report).toMatch(/terminal phase[\s\S]*do not navigate, replay, spider, scan/i)
  })

  test("does not introduce phase gates or HTTP-response retry policy", async () => {
    const skill = await read()
    expect(skill).not.toMatch(/defer|blocked|approval gate|scoped report|required phase/i)
    expect(skill).not.toMatch(/403|429|WAF|managed challenge|retry/i)
  })
})
