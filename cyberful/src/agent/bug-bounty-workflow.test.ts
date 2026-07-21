// ── Built-In Bug Bounty Workflow Tests ──────────────────────────
// Verifies the dedicated policy boundaries, shared Pentest execution personas,
// submission artifacts, budgets, and live-target capability contract.
// → cyberful/src/subsystem/phase.ts — owns workflow policy and persona resolution.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import * as Builtin from "@/builtin"
import * as ConfigAgent from "@/config/agent"
import { SubsystemCodex } from "@/subsystem/codex"
import * as SubsystemPhase from "@/subsystem/phase"
import { isRecord } from "@/util/record"

const PHASES = [
  ["brief", "MISSION.md", 10],
  ["recon", "RECON.md", 60],
  ["exploit", "EXPLOIT.md", 120],
  ["hacker", "HACKER.md", 90],
  ["verify", "BUG_BOUNTY_VERIFY.md", 45],
  ["report", "BUG_BOUNTY_REPORT.md", 30],
] as const

describe("built-in Bug Bounty Program workflow", () => {
  const home = path.join(Builtin.DIR, "agents", "bug-bounty")

  test("exposes the live-target chain and Markdown submission index", () => {
    const workflow = SubsystemPhase.workflow("bug-bounty")
    expect(workflow?.kind).toBe("workflow")
    if (workflow?.kind !== "workflow") throw new Error("Bug Bounty Program must be sequential")

    expect(workflow.title).toBe("Bug Bounty Program")
    expect(workflow.phases.map((phase) => phase.name)).toEqual(PHASES.map(([phase]) => phase))
    expect(workflow.sourcePolicy).toBe("none")
    expect(workflow.capabilities).toEqual(["isolated-exec", "browser", "zap"])
    expect(workflow.zapLifecycle).toBe("engagement")
    expect(workflow.completionTitle).toBe("Bug bounty assessment completed")
    expect(workflow.nextWorkflow).toBe("ask")
    expect(workflow.report).toEqual({
      source: "BUG_BOUNTY_REPORT.md",
      path: "BUG_BOUNTY_REPORT.md",
      mime: "text/markdown",
    })
    expect(SubsystemPhase.terminalArtifacts("bug-bounty")).toEqual([
      {
        label: "Bug bounty submissions",
        path: "BUG_BOUNTY_REPORT.md",
        mime: "text/markdown",
        primary: true,
      },
    ])
  })

  test("uses dedicated boundary personas and the exact Pentest execution personas", async () => {
    const agents = await ConfigAgent.load(Builtin.DIR)
    expect(
      fs
        .readdirSync(home)
        .filter((file) => file.endsWith(".md"))
        .toSorted(),
    ).toEqual(["brief.md", "report.md", "verify.md"])

    for (const phase of ["brief", "verify", "report"] as const) {
      expect(agents[`bug-bounty/${phase}`]).toBeDefined()
      expect(SubsystemPhase.personaPath(home, phase, "bug-bounty")).toBe(path.join(home, `${phase}.md`))
    }
    for (const phase of ["recon", "exploit", "hacker"] as const) {
      expect(SubsystemPhase.personaPath(home, phase, "bug-bounty")).toBe(
        path.join(Builtin.DIR, "agents", "pentest", `${phase}.md`),
      )
    }
    expect(SubsystemPhase.personaPath("/custom/agents/bug-bounty", "recon", "bug-bounty")).toBe(
      "/custom/agents/pentest/recon.md",
    )
  })

  test("packages the Pentest-equivalent budgets, artifacts, successors, and delegation limits", () => {
    const budgets: unknown = JSON.parse(fs.readFileSync(SubsystemPhase.budgetsPath(home), "utf8"))
    if (!isRecord(budgets)) throw new Error("Bug Bounty budgets must be an object")

    for (const [index, [phase, artifact, minutes]] of PHASES.entries()) {
      const successor = PHASES[index + 1]?.[0]
      expect(SubsystemPhase.deliverableFor("bug-bounty", phase)).toBe(artifact)
      expect(SubsystemPhase.nextAfterExpertPhase("bug-bounty", phase)).toBe(successor)
      expect(budgets[phase]).toBe(minutes)
    }

    expect(
      Object.fromEntries(
        PHASES.map(([phase]) => [
          phase,
          SubsystemCodex.parsePersona(
            fs.readFileSync(SubsystemPhase.personaPath(home, phase, "bug-bounty"), "utf8"),
          ).subagents,
        ]),
      ),
    ).toEqual({ brief: 0, recon: 3, exploit: 2, hacker: 2, verify: 0, report: 0 })
  })

  test("brief records program policy without inventing missing rules", () => {
    const brief = fs.readFileSync(path.join(home, "brief.md"), "utf8")
    for (const anchor of [
      "Safe harbor and authorization",
      "Eligible and ineligible vulnerability classes",
      "Data handling",
      "Disclosure and submission rules",
      "Open questions and missing policy",
      "program_name",
      "program_platform",
      "program_policy_url",
    ]) {
      expect(brief).toContain(anchor)
    }
    expect(brief).toContain("Not provided")
    expect(brief).toMatch(/Never infer authorization/i)
    expect(brief).toContain('artifact: "MISSION.md"')
    expect(brief).toContain("target `recon`")
  })

  test("verify gates readiness and report emits only portable ready submissions", () => {
    const verify = fs.readFileSync(path.join(home, "verify.md"), "utf8")
    const report = fs.readFileSync(path.join(home, "report.md"), "utf8")

    for (const verdict of ["SURVIVES", "REVISE", "DEMOTE"]) expect(verify).toContain(verdict)
    for (const status of ["SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"])
      expect(verify).toContain(status)
    expect(verify).toContain("Not assessed")
    expect(verify).toContain('artifact: "BUG_BOUNTY_VERIFY.md"')

    expect(report).toContain("reports/bug-bounty/BBP-###.md")
    expect(report).toContain("CVSS 3.1")
    expect(report).toContain("No submission-ready findings")
    expect(report).toMatch(/Report\s+only entries marked exactly `SUBMISSION_READY`/)
    expect(report).toMatch(/Do not include SOC 2 or ISO mappings/i)
    expect(report).toMatch(/payout estimates/i)
    expect(report).toContain('artifact: "BUG_BOUNTY_REPORT.md"')
    expect(report).toContain("target `complete`")
  })
})
