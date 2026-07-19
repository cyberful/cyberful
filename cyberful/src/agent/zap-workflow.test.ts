// ── Persona ZAP Workflow Tests ───────────────────────────────────
// Verifies that shipped pentest personas and the reusable ZAP skill preserve
// proxy checks, serialized reporting, exact replay targets, and evidence ownership.
// → cyberful/builtin/skills/ZAP.md — defines the shared workflow under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as Builtin from "@/builtin"

describe("ZAP phase workflow", () => {
  const read = (name: string) => readFile(path.join(Builtin.DIR, "agents", "pentest", name), "utf8")
  const readSkill = () => readFile(path.join(Builtin.DIR, "skills", "ZAP.md"), "utf8")

  test("keeps report generation serialized after concurrent Recon work", async () => {
    expect(await read("brief.md")).not.toContain("RECON_PARTITION")
    expect(await read("recon.md")).toMatch(/Generate durable ZAP reports only after concurrent Recon work has settled/i)
  })

  test("delegates the final snapshot procedure to the reusable skill", async () => {
    const report = await read("report.md")
    expect(report).toMatch(/load and follow the builtin `zap` skill/i)
    expect(report).toMatch(/Final engagement snapshot/i)
    expect(report).not.toContain("zap_get_passive_scan_status")
    expect(report).not.toContain("zap_generate_scoped_report")

    const skill = await readSkill()
    const snapshot = skill.slice(skill.indexOf("## Final engagement snapshot"))
    const history = snapshot.indexOf("all target traffic has completed")
    const passive = snapshot.indexOf("zap_get_passive_scan_status")
    const generate = snapshot.indexOf("zap_generate_scoped_report")
    expect(history).toBeGreaterThanOrEqual(0)
    expect(passive).toBeGreaterThan(history)
    expect(generate).toBeGreaterThan(passive)
    expect(snapshot).toMatch(/only the\s+authorized origins/i)
    expect(snapshot).toMatch(/does not authorize navigation, replay, spidering, scanning/i)
  })

  test("directs every ZAP-using phase to the same builtin skill", async () => {
    const personas = await Promise.all(["recon.md", "exploit.md", "hacker.md", "verify.md", "report.md"].map(read))
    expect(personas.every((persona) => /load and follow the builtin `zap` skill/i.test(persona))).toBe(true)
  })

  test("preserves exact destination semantics from brief through replay", async () => {
    expect(await read("brief.md")).toMatch(/never shorten an absolute URL to a path or drop its scheme/i)
    expect(await read("verify.md")).toMatch(/exact absolute URL as `target_url`/i)
  })

  test("does not let one HTTP rejection suppress independent hypotheses", async () => {
    const recon = await read("recon.md")
    expect(recon).toMatch(/A single response does not stop the phase or suppress unrelated/i)
    expect(recon).not.toMatch(/`403`, `429`,[\s\S]{0,100}circuit.breaker/i)
    expect(recon).toMatch(/explicit mission stop[\s\S]*scope uncertainty[\s\S]*instability/i)
  })
})

describe("built-in ZAP MCP skill", () => {
  const read = () => readFile(path.join(Builtin.DIR, "skills", "ZAP.md"), "utf8")

  test("advertises the integrated browser and bridge workflow for native discovery", async () => {
    const skill = await read()
    expect(skill).toMatch(/^---\nname: ZAP\n/)
    expect(skill).toMatch(/description: .*official MCP surface and controlled bridge/i)
    expect(skill).toMatch(/- browser_status/)
    expect(skill).toMatch(/every `browser_\*`[\s\S]*traverse the proxy automatically/i)
  })

  test("fails closed before traffic and preserves shared-history ownership", async () => {
    const skill = await read()
    expect(skill).toMatch(/`proxy\.configured` is `true` and `proxy\.mode` is exactly `zap`/i)
    expect(skill).toMatch(/A `pending` result is not permission to\s+navigate/i)
    expect(skill).toMatch(/native Codex subagents share one engagement-owned ZAP history/i)
    expect(skill).toMatch(/leave final report generation to the serialized Report phase/i)
  })

  test("documents the stable replay and controlled API boundaries", async () => {
    const skill = await read()
    expect(skill).toContain("zap_history_search")
    expect(skill).toContain("zap_history_get")
    expect(skill).toContain("zap_http_request")
    expect(skill).toContain("zap_api_catalog")
    expect(skill).toContain("zap_api_call")
    expect(skill).toMatch(/origin-form requests require `target_url`/i)
    expect(skill).toMatch(/File transfer is intentionally disabled/i)
  })

  test("keeps HTTP rejection local and publishes the real OAST API boundary", async () => {
    const skill = await read()
    expect(skill).toMatch(/does not stop unrelated authorized work/i)
    expect(skill).not.toMatch(/`403`, `429`,[\s\S]{0,80}circuit.breaker/i)
    expect(skill).toMatch(/Call `zap_oast` without an operation first/i)
    expect(skill).toMatch(/does not expose[\s\S]*registration[\s\S]*payload generation[\s\S]*polling/i)
  })
})
