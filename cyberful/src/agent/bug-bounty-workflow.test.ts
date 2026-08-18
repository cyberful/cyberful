// ── Built-In Bug Bounty Workflow Tests ──────────────────────────
// Verifies dedicated reward-aware personas, policy boundaries,
// submission artifacts, budgets, and live-target capability contract.
// → cyberful/src/subsystem/phase.ts — owns workflow policy and persona resolution.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import * as Builtin from "@/builtin"
import * as ConfigAgent from "@/config/agent"
import { AgentPromptCompiler } from "@/subsystem/prompt-compiler"
import { SubsystemPhaseRunner } from "@/subsystem/phase-runner"
import * as SubsystemPhase from "@/subsystem/phase"
import { isRecord } from "@/util/record"

const PHASES = [
  ["brief", "MISSION.md", 30],
  ["recon", "RECON.md", 60],
  ["exploit", "EXPLOIT.md", 120],
  ["hacker", "HACKER.md", 120],
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
    expect(workflow.sourcePolicy).toBe("read")
    expect(workflow.capabilities).toEqual([
      "source",
      "isolated-exec",
      "browser",
      "zap",
      "ghidra",
      "evm-lab",
      "firmware-lab",
      "native-analysis",
      "native-debug",
      "fuzz-campaign",
      "protocol-campaign",
      "cve-dictionary",
    ])
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

  test("uses one dedicated persona for every Bug Bounty phase", async () => {
    const agents = await ConfigAgent.load(Builtin.DIR)
    expect(
      fs
        .readdirSync(home)
        .filter((file) => file.endsWith(".md"))
        .toSorted(),
    ).toEqual(["brief.md", "exploit.md", "hacker.md", "recon.md", "report.md", "verify.md"])

    for (const [phase] of PHASES) {
      expect(agents[`bug-bounty/${phase}`]).toBeDefined()
      expect(SubsystemPhase.personaPath(home, phase, "bug-bounty")).toBe(path.join(home, `${phase}.md`))
    }
    expect(SubsystemPhase.personaPath("/custom/agents/bug-bounty", "recon", "bug-bounty")).toBe(
      "/custom/agents/bug-bounty/recon.md",
    )
  })

  test("packages bounded Bug Bounty budgets, artifacts, successors, and delegation limits", () => {
    const budgets: unknown = JSON.parse(fs.readFileSync(SubsystemPhase.budgetsPath(home), "utf8"))
    if (!isRecord(budgets)) throw new Error("Bug Bounty budgets must be an object")

    for (const [index, [phase, artifact, minutes]] of PHASES.entries()) {
      const successor = PHASES[index + 1]?.[0]
      expect(SubsystemPhase.deliverableFor("bug-bounty", phase)).toBe(artifact)
      expect(SubsystemPhase.nextAfterExpertPhase("bug-bounty", phase)).toBe(successor)
      expect(budgets[phase]).toBe(minutes)
    }
    expect(budgets.$novelty).toEqual({
      recon: { required: true, mode: "bounty-portfolio" },
      exploit: { required: true, mode: "bounty-portfolio" },
      hacker: { required: true, mode: "bounty-portfolio" },
    })

    expect(
      Object.fromEntries(
        PHASES.map(([phase]) => [
          phase,
          AgentPromptCompiler.parsePersona(
            fs.readFileSync(SubsystemPhase.personaPath(home, phase, "bug-bounty"), "utf8"),
          ).subagents,
        ]),
      ),
    ).toEqual({ brief: 0, recon: 3, exploit: 5, hacker: 5, verify: 0, report: 0 })
  })

  test("research personas optimize reward, protect scarce browser access, use a root critic, and nudge skills", () => {
    const recon = fs.readFileSync(SubsystemPhase.personaPath(home, "recon", "bug-bounty"), "utf8")
    const exploit = fs.readFileSync(SubsystemPhase.personaPath(home, "exploit", "bug-bounty"), "utf8")
    const hacker = fs.readFileSync(SubsystemPhase.personaPath(home, "hacker", "bug-bounty"), "utf8")

    expect(recon).toMatch(/maximize the highest eligible, defensible bounty reward/i)
    expect(recon).toContain("`bounty_context`")
    expect(recon).toMatch(/without scores, quotas, or formulas/i)
    expect(exploit).toContain('`display_name: "portfolio-critic"`')
    expect(exploit).toContain('`output_artifact: "raw/strategy/exploit-portfolio-critic.md"`')
    expect(exploit).toMatch(/original phase root[\s\S]*first half/i)
    expect(exploit).toMatch(/advisory and artifact-only/i)
    expect(exploit).toContain("`UNTESTABLE`")
    expect(exploit).toContain('`display_name: "finding-breaker"`')
    expect(exploit).toContain("raw/strategy/exploit-finding-breaker.md")
    expect(hacker).toContain('`output_artifact: "raw/strategy/hacker-portfolio-critic.md"`')
    expect(hacker).toContain('`display_name: "finding-breaker"`')
    expect(hacker).toContain("raw/strategy/hacker-finding-breaker.md")
    expect(hacker).toMatch(/after two negatives converge[\s\S]*change impact, boundary, or enforcement owner/i)
    for (const persona of [recon, exploit, hacker]) {
      expect(persona).toMatch(/narrowest useful skill/i)
      expect(persona).toMatch(/hypothesis/i)
      expect(persona).toMatch(/not a score|never score|without scores/i)
      expect(persona).toMatch(/Preserve a browser profile[\s\S]*another profile for parallel exploration/i)
      expect(persona).toMatch(/Before handoff[\s\S]*tabs and in-memory state are closed/i)
    }
  })

  test("brief records program policy without inventing missing rules", () => {
    const brief = fs.readFileSync(path.join(home, "brief.md"), "utf8")
    for (const anchor of [
      "authorization",
      "in/out-of-scope assets",
      "eligible/ineligible",
      "data rules",
      "disclosure rules",
      "provided identities",
    ]) {
      expect(brief).toContain(anchor)
    }
    expect(brief).toContain("`UNRESOLVED`")
    expect(brief).toContain("`engagement_policy configure`")
    expect(brief).toContain("`engagement_policy finalize`")
    expect(brief).toMatch(/mandatory non-secret request header/i)
    expect(brief.indexOf("`engagement_policy configure`")).toBeLessThan(brief.indexOf("`browser_status`"))
    expect(brief.indexOf("`engagement_policy finalize`")).toBeGreaterThan(brief.indexOf("`browser_status`"))
    expect(brief).toMatch(/Do not infer authorization or a restriction/i)
    expect(brief).toMatch(/one exact action and asset/i)
    expect(brief).toMatch(/resolution\s+attempt/i)
    expect(brief).not.toContain("MISSION GUARDRAIL")
    expect(brief).toMatch(/Handoff `MISSION\.md` to Recon/i)
  })

  test("brief preflights supplied access and records one bounded prerequisite matrix", () => {
    const brief = fs.readFileSync(path.join(home, "brief.md"), "utf8")

    expect(brief).toContain("provided identities")
    expect(brief).toMatch(/Handoff `MISSION\.md` to Recon/i)
    for (const preflightInstruction of [
      "Account, proxy, and application preflight",
      "`browser_status`",
      "`proxy.mode=zap`",
      "`browser_network_log`",
      "`OK, retry`",
      "Prerequisite matrix",
      "`READY`",
      "`BLOCKED`",
      "`IN_SCOPE`",
      "`OUT_OF_SCOPE`",
      "`UNRESOLVED`",
    ]) {
      expect(brief).toContain(preflightInstruction)
    }
    expect(brief).toMatch(/complete the normal login autonomously/i)
    expect(brief).toContain("{{var:<saved-name>}}")
    expect(brief).toContain("[session-variable:<saved-name>]")
    expect(brief).not.toContain("{{var:name}}")
    expect(brief).toMatch(/numbered target profiles `1` through `5`/i)
    expect(brief).toMatch(/`search` profile is not a supplied account/i)
    expect(brief).toMatch(/`proxy\.configured=false` with `proxy\.mode=direct`/i)
    expect(brief).toMatch(/excluded from this account preflight, prerequisite-matrix profile readiness, and engagement-policy profile states/i)
    expect(brief).toMatch(/Never ask the human to restore ZAP for `search`/i)
    expect(brief).toMatch(/Ask the human only after autonomous login cannot continue/i)
    expect(brief).not.toMatch(/Never enter credentials/i)
    expect(brief).toMatch(/not an exhaustive vulnerability checklist/i)
    expect(brief).not.toContain("`NOT_PROVIDED`")
    expect(brief).not.toContain("`POLICY_UNKNOWN`")
  })

  test("verify gates readiness and report emits only portable ready submissions", () => {
    const verify = fs.readFileSync(path.join(home, "verify.md"), "utf8")
    const report = fs.readFileSync(path.join(home, "report.md"), "utf8")

    for (const verdict of ["SURVIVES", "REVISE", "DEMOTE"]) expect(verify).toContain(verdict)
    for (const status of ["SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"]) expect(verify).toContain(status)
    expect(verify).toMatch(/Reproduction proves a mechanism, not necessarily a vulnerability/i)
    expect(verify).toMatch(/violated security invariant/i)
    expect(verify).toMatch(/cheapest benign explanation/i)
    expect(verify).toMatch(/Write `BUG_BOUNTY_VERIFY\.md`/i)

    expect(report).toContain("reports/bug-bounty/BBP-###.md")
    expect(report).toMatch(/Assign CVSS only when every metric is supported/i)
    expect(report).toMatch(/even with zero ready findings/i)
    expect(report).toContain("`Not assessed`")
    expect(report).toMatch(/For each `SUBMISSION_READY` entry/i)
    expect(report).toMatch(/estimate rewards/i)
    expect(report).toMatch(/Write `BUG_BOUNTY_REPORT\.md`/i)
    expect(report).toMatch(/to `complete`/i)
  })

  test("keeps the permanent Bug Bounty instruction corpus within 2,500 words", () => {
    const personas = PHASES.map(([phase]) =>
      fs.readFileSync(SubsystemPhase.personaPath(home, phase, "bug-bounty"), "utf8"),
    )
    const skills = ["nuclei", "zap"].map((name) =>
      fs.readFileSync(path.join(Builtin.DIR, "skills", name, "SKILL.md"), "utf8"),
    )
    const runners = PHASES.map(([phase]) =>
      SubsystemPhaseRunner.buildPhasePrompt(
        {
          phase,
          workflow: "bug-bounty",
          sessionID: "budget-test",
          workareaCwd: "/workarea",
          home,
          objective: "objective",
          timeoutMs: 1,
          handoff: { successor: phase === "report" ? undefined : "next" },
        },
        1,
        ["recon", "exploit", "hacker"].includes(phase) ? { required: true, mode: "bounty-portfolio" } : undefined,
      ),
    )
    const runner = runners.toSorted((left, right) => right.split(/\s+/).length - left.split(/\s+/).length)[0] ?? ""
    const permanentWords = [runner, ...personas, ...skills].join("\n").trim().split(/\s+/).length

    expect(permanentWords).toBeLessThanOrEqual(2_500)
  })
})
