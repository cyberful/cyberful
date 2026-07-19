// ── Built-In AppSec Workflow Tests ────────────────────────────────
// Verifies that every graph-assisted workflow resolves to packaged personas,
//   budgets, source policy, capabilities, artifacts, and exact handoffs.
// → cyberful/src/subsystem/phase.ts — owns the public workflow registry.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import * as Builtin from "@/builtin"
import * as ConfigAgent from "@/config/agent"
import * as SubsystemPhase from "@/subsystem/phase"
import { isRecord } from "@/util/record"

const WORKFLOWS = {
  "code-audit": {
    sourcePolicy: "read",
    capabilities: ["source", "code-graph", "isolated-exec"],
    completionTitle: "Code audit completed",
    report: ["CODE_AUDIT_REPORT.md", "reports/code-audit-report.pdf"],
    phases: [
      ["scope", "CODE_SCOPE.md", 30],
      ["index", "CODE_GRAPH.md", 60],
      ["trace", "CODE_TRACE.md", 60],
      ["hunt", "CODE_HUNT.md", 60],
      ["verify", "CODE_VERIFY.md", 60],
      ["report", "CODE_AUDIT_REPORT.md", 30],
    ],
  },
  assessment: {
    sourcePolicy: "read",
    capabilities: ["source", "code-graph", "isolated-exec", "browser", "zap"],
    completionTitle: "Security assessment completed",
    report: ["ASSESSMENT_REPORT.md", "reports/security-assessment.pdf"],
    phases: [
      ["brief", "ASSESSMENT_MISSION.md", 15],
      ["map", "ASSESSMENT_MAP.md", 45],
      ["controls", "ASSESSMENT_CONTROLS.md", 45],
      ["test", "ASSESSMENT_TEST.md", 60],
      ["correlate", "ASSESSMENT_RISK.md", 60],
      ["verify", "ASSESSMENT_VERIFY.md", 45],
      ["report", "ASSESSMENT_REPORT.md", 40],
    ],
  },
  remediate: {
    sourcePolicy: "remediate",
    capabilities: ["source", "code-graph", "isolated-exec", "remediation-git", "browser", "zap"],
    completionTitle: "Remediation completed",
    report: ["REMEDIATION_REPORT.md", "REMEDIATION_REPORT.md"],
    phases: [
      ["intake", "REMEDIATION_SCOPE.md", 20],
      ["plan", "REMEDIATION_PLAN.md", 20],
      ["implement", "REMEDIATION_CHANGES.md", 90],
      ["verify", "REMEDIATION_VERIFY.md", 60],
      ["publish", "REMEDIATION_REPORT.md", 20],
    ],
  },
  "secure-review": {
    sourcePolicy: "review",
    capabilities: ["source", "code-graph", "isolated-exec", "git-review"],
    completionTitle: "Secure review completed",
    report: ["SECURE_REVIEW.md", "SECURE_REVIEW.md"],
    phases: [
      ["map", "REVIEW_MAP.md", 15],
      ["audit", "REVIEW_FINDINGS.md", 35],
      ["verify", "SECURE_REVIEW.md", 25],
    ],
  },
} as const

describe("built-in graph-assisted AppSec workflows", () => {
  test("the registry exposes each complete chain and its host policy", () => {
    for (const [workflowName, expected] of Object.entries(WORKFLOWS)) {
      const workflow = SubsystemPhase.workflow(workflowName)
      expect(workflow?.kind).toBe("workflow")
      if (workflow?.kind !== "workflow") throw new Error(`${workflowName} must be a workflow`)

      expect(workflow.phases.map((phase) => phase.name)).toEqual(expected.phases.map(([phase]) => phase))
      expect(workflow.sourcePolicy).toBe(expected.sourcePolicy)
      expect(workflow.capabilities).toEqual(expected.capabilities)
      expect(workflow.completionTitle).toBe(expected.completionTitle)
      expect([workflow.report.source, workflow.report.path]).toEqual([...expected.report])
      expect(SubsystemPhase.nextWorkflow(workflowName)).toBe("ask")
      for (const capability of expected.capabilities)
        expect(SubsystemPhase.hasCapability(workflowName, capability)).toBe(true)
    }
    expect(SubsystemPhase.hasCapability("code-audit", "browser")).toBe(false)
    expect(SubsystemPhase.hasCapability("secure-review", "zap")).toBe(false)
  })

  test("every phase has a packaged persona, enforced budget, deliverable, and exact successor", async () => {
    const agents = await ConfigAgent.load(Builtin.DIR)
    for (const [workflowName, expected] of Object.entries(WORKFLOWS)) {
      const home = SubsystemPhase.workflowHome(workflowName)
      const parsedBudgets: unknown = JSON.parse(fs.readFileSync(SubsystemPhase.budgetsPath(home), "utf8"))
      if (!isRecord(parsedBudgets)) throw new Error(`${workflowName} budgets must be an object`)
      const packagedPersonas = fs
        .readdirSync(home)
        .filter((file) => file.endsWith(".md"))
        .toSorted()
      expect(packagedPersonas).toEqual(expected.phases.map(([phase]) => `${phase}.md`).toSorted())

      for (const [index, entry] of expected.phases.entries()) {
        const [phase, deliverable, budget] = entry
        const successor = expected.phases[index + 1]?.[0]
        const personaPath = SubsystemPhase.personaPath(home, phase)
        const persona = fs.readFileSync(personaPath, "utf8")

        expect(agents[`${workflowName}/${phase}`], `${workflowName}/${phase} must load from the built-in catalog`).toBeDefined()
        expect(parsedBudgets[phase]).toBe(budget)
        expect(SubsystemPhase.isExpertPhase(workflowName, phase)).toBe(true)
        expect(SubsystemPhase.deliverableFor(workflowName, phase)).toBe(deliverable)
        expect(SubsystemPhase.nextAfterExpertPhase(workflowName, phase)).toBe(successor)
        expect(persona).toContain(`\`artifact: "${deliverable}"\``)
        expect(persona).toContain(successor ? `target \`${successor}\`` : "target `complete`")
      }
    }
  })

  test("shared phase names resolve only inside their persisted workflow", () => {
    for (const ambiguous of ["brief", "map", "verify", "report"])
      expect(SubsystemPhase.workflowOf(ambiguous)).toBeUndefined()

    expect(SubsystemPhase.deliverableFor("pentest", "verify")).toBe("VERIFY.md")
    expect(SubsystemPhase.deliverableFor("code-audit", "verify")).toBe("CODE_VERIFY.md")
    expect(SubsystemPhase.deliverableFor("assessment", "verify")).toBe("ASSESSMENT_VERIFY.md")
    expect(SubsystemPhase.deliverableFor("remediate", "verify")).toBe("REMEDIATION_VERIFY.md")
    expect(SubsystemPhase.deliverableFor("secure-review", "verify")).toBe("SECURE_REVIEW.md")
  })

  test("remediation personas bind host test proof to stage, findings, exit semantics, and Git state", () => {
    const home = SubsystemPhase.workflowHome("remediate")
    const plan = fs.readFileSync(SubsystemPhase.personaPath(home, "plan"), "utf8")
    const implement = fs.readFileSync(SubsystemPhase.personaPath(home, "implement"), "utf8")
    const verify = fs.readFileSync(SubsystemPhase.personaPath(home, "verify"), "utf8")

    expect(plan).toContain('stage: "pre-fix"')
    expect(plan).toContain("finding_ids")
    expect(plan).toContain("model-selected")
    expect(plan).toContain("zero/non-zero convention")
    expect(plan).toContain("clean prepared base")
    for (const persona of [implement, verify]) {
      expect(persona).toContain('stage: "post-fix"')
      expect(persona).toContain('stage: "regression"')
      expect(persona).toContain("finding_ids")
      expect(persona).toContain("expected_exit_codes")
      expect(persona).toMatch(/Git[- ]delta/)
    }
  })

  test("terminal output declarations include validated structured exports", () => {
    expect(SubsystemPhase.terminalArtifacts("code-audit").map((artifact) => artifact.path)).toEqual([
      "reports/code-audit-report.pdf",
      "CODE_AUDIT_REPORT.md",
      "reports/code-audit.sarif",
    ])
    expect(SubsystemPhase.terminalArtifacts("assessment").map((artifact) => artifact.path)).toEqual([
      "reports/security-assessment.pdf",
      "ASSESSMENT_REPORT.md",
      "reports/assessment-evidence.json",
    ])
    expect(SubsystemPhase.terminalArtifacts("remediate").map((artifact) => artifact.path)).toEqual([
      "REMEDIATION_REPORT.md",
      "reports/remediation.patch",
      "reports/remediation-publish.json",
    ])
    expect(SubsystemPhase.terminalArtifacts("secure-review").map((artifact) => artifact.path)).toEqual([
      "SECURE_REVIEW.md",
      "reports/secure-review.sarif",
    ])
  })
})
