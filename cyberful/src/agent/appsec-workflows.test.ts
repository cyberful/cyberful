// ── Built-In Code Audit Workflow Tests ──────────────────────────
// Locks the seven-phase deep audit, phase contracts, budgets, capabilities,
// personas, and structured terminal exports.
// → cyberful/src/subsystem/phase.ts — owns the public workflow registry.
// ────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import * as Builtin from "@/builtin"
import * as ConfigAgent from "@/config/agent"
import * as SubsystemPhase from "@/subsystem/phase"
import { isRecord } from "@/util/record"

const PHASES = [
  ["scope", "CODE_SCOPE.md", 30],
  ["index", "CODE_GRAPH.md", 60],
  ["trace", "CODE_TRACE.md", 75],
  ["hunt", "CODE_HUNT.md", 90],
  ["attack", "CODE_ATTACK.md", 90],
  ["verify", "CODE_VERIFY.md", 75],
  ["report", "CODE_AUDIT_REPORT.md", 45],
] as const

describe("built-in Code Audit workflow", () => {
  test("exposes the complete read-only chain and host policy", () => {
    const workflow = SubsystemPhase.workflow("code-audit")
    expect(workflow?.kind).toBe("workflow")
    if (workflow?.kind !== "workflow") throw new Error("Code Audit must be sequential")
    expect(workflow.phases.map((phase) => phase.name)).toEqual(PHASES.map(([phase]) => phase))
    expect(workflow.sourcePolicy).toBe("read")
    expect(workflow.capabilities).toEqual(["source", "code-graph", "isolated-exec", "audit-diff"])
    expect(workflow.completionTitle).toBe("Code audit completed")
    expect([workflow.report.source, workflow.report.path]).toEqual([
      "CODE_AUDIT_REPORT.md",
      "reports/code-audit-report.pdf",
    ])
    expect(SubsystemPhase.hasCapability("code-audit", "browser")).toBe(false)
    expect(SubsystemPhase.hasCapability("code-audit", "zap")).toBe(false)
  })

  test("packages every persona with its exact budget, artifact, and successor", async () => {
    const agents = await ConfigAgent.load(Builtin.DIR)
    const home = SubsystemPhase.workflowHome("code-audit")
    const budgets: unknown = JSON.parse(fs.readFileSync(SubsystemPhase.budgetsPath(home), "utf8"))
    if (!isRecord(budgets)) throw new Error("Code Audit budgets must be an object")
    expect(
      fs
        .readdirSync(home)
        .filter((file) => file.endsWith(".md"))
        .toSorted(),
    ).toEqual(PHASES.map(([phase]) => `${phase}.md`).toSorted())

    for (const [index, [phase, deliverable, budget]] of PHASES.entries()) {
      const successor = PHASES[index + 1]?.[0]
      const persona = fs.readFileSync(SubsystemPhase.personaPath(home, phase), "utf8")
      expect(agents[`code-audit/${phase}`]).toBeDefined()
      expect(budgets[phase]).toBe(budget)
      expect(SubsystemPhase.deliverableFor("code-audit", phase)).toBe(deliverable)
      expect(SubsystemPhase.nextAfterExpertPhase("code-audit", phase)).toBe(successor)
      expect(persona).toContain(`\`artifact: "${deliverable}"\``)
      expect(persona).toContain(successor ? `target \`${successor}\`` : "target `complete`")
    }
  })

  test("publishes report, SARIF, and structured evidence", () => {
    expect(SubsystemPhase.terminalArtifacts("code-audit").map((artifact) => artifact.path)).toEqual([
      "reports/code-audit-report.pdf",
      "CODE_AUDIT_REPORT.md",
      "reports/code-audit.sarif",
      "reports/code-audit-evidence.json",
    ])
  })
})
