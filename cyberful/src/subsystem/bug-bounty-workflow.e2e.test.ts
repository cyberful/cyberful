// ── Local Bug Bounty Workflow E2E ───────────────────────────────
// Exercises the research contracts together without target traffic: browser
//   coverage, causal pivots, child usage, Pi provenance, and full handoff.
// → cyberful/src/subsystem/orchestrator.ts — owns sequential advancement.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { HypothesisRegistry } from "./gateway/hypothesis-registry"
import { SurfaceCoverage } from "./gateway/surface-coverage"
import { SubsystemOrchestrator } from "./orchestrator"
import { SubsystemPhase } from "./phase"
import type { PhaseResult } from "./phase-runner"
import { AgentPromptCompiler } from "./prompt-compiler"
import { SubsystemUsage } from "./usage"

const PROMPT_TEMPLATE = [
  "=={{AUTHORIZATION}}==",
  "# Hacker Profile",
  "{{CYBERFUL_HACKER_PROFILE}}",
  "# Cyberful Subsystem Delegation",
  "{{CYBERFUL_SUBSYSTEM_DELEGATION}}",
  "# Cyberful Workarea",
  "{{CYBERFUL_WORKAREA}}",
].join("\n\n")

function phasePrompt(phase: string) {
  const sharedPentestPersona = ["recon", "exploit", "hacker"].includes(phase)
  return AgentPromptCompiler.compile({
    templateSource: PROMPT_TEMPLATE,
    personaSource: `---\nsubagents: ${sharedPentestPersona ? 3 : 0}\n---\n# ${phase} persona`,
    workareaSource: "Use only the phase workarea and gateway.",
    runtimeInstructions: "Preserve evidence, write the deliverable, and let only the root perform handoff.",
    workflow: "bug-bounty",
    phase,
    personaID: `${sharedPentestPersona ? "pentest" : "bug-bounty"}/${phase}`,
    role: "root",
    providerRoute: "main",
    handoffOwner: true,
    delegationEnabled: true,
    userTask: `Complete the Bug Bounty ${phase} phase.`,
  })
}

function browserResult(action: string, family: string, route: string, profile = 1) {
  return {
    content: [{ type: "text" as const, text: "ok" }],
    _meta: {
      "cyberful.dev/browser-action": {
        profile,
        page_id: `page-${profile}`,
        origin: "https://target.test",
        path_family: route,
        action,
        action_family: family,
        page_transition: "same_origin",
        outcome: "ok",
        status: 200,
      },
    },
  }
}

function hypothesis(id: string, rootCause: string) {
  return {
    id,
    owner: "phase-root",
    description: `${rootCause} boundary`,
    root_cause: rootCause,
    surface: `${rootCause} service`,
    discriminator: `differential response for ${rootCause}`,
  }
}

test("local Bug Bounty path combines broad navigation, causal pivots, child usage, and complete handoff", async () => {
  const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-bounty-e2e-")))
  try {
    const coverage = new SurfaceCoverage(workarea, "recon")
    await coverage.observe(browserResult("browser_navigate", "navigation", "/dashboard"))
    await coverage.observe(browserResult("browser_click", "ui_interaction", "/settings/security"))
    await coverage.observe(browserResult("browser_type", "ui_input", "/trade/order", 2))
    await coverage.close()

    const pivots = [
      ["recon", hypothesis("RC-1", "authorization graph")],
      ["exploit", hypothesis("EX-1", "workflow race")],
      ["hacker", hypothesis("HK-1", "key custody seam")],
    ] as const
    for (const [phase, entry] of pivots) {
      const registry = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase,
        synthesisRequired: true,
      })
      await registry.handle({ action: "record", ...entry })
      await registry.handle({ action: "update", id: entry.id, state: "TESTING" })
      await registry.handle({
        action: "update",
        id: entry.id,
        state: "DISPROVED",
        evidence: [`${entry.id} exercised the ${entry.surface} discriminator.`],
        reason: "The controlled differential did not reproduce.",
      })
      await registry.handle({
        action: "synthesize",
        outcome: "diversified",
        summary: `${phase} pivoted to a target-specific causal boundary.`,
        evidence: [`${entry.id} tests ${entry.root_cause} at ${entry.surface}.`],
        remaining_unknowns: [],
      })
      expect(await registry.handoffError()).toBeUndefined()
    }

    const usage = SubsystemUsage.createSessionCounter()
    usage.observe({}, { scopeID: "root", generatedTokens: 20, inputTokens: 100, reasoningTokens: 8 })
    usage.observe({}, { scopeID: "subagent-01", generatedTokens: 15, inputTokens: 60, reasoningTokens: 6 })

    const phases: string[] = []
    const systems: string[] = []
    const personaIDs: string[] = []
    const workflow = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        {
          workflow: "bug-bounty",
          sessionID: SessionID.make("ses_bounty_e2e"),
          startPhase: "brief",
          objective: "local contract exercise",
          workareaCwd: workarea,
          home: workarea,
          settingsDirectory: workarea,
          path: { cwd: workarea, root: workarea },
          timeoutMs: 1_000,
        },
        {
          runPhase: async (spec): Promise<PhaseResult> => {
            phases.push(spec.phase)
            const prompt = phasePrompt(spec.phase)
            systems.push(prompt.system)
            personaIDs.push(prompt.manifest.personaID)
            return {
              phase: spec.phase,
              ok: true,
              summary: `${spec.phase} complete`,
              exitCode: 0,
              timedOut: false,
              termination: "completed",
              backend: "pi",
              durationMs: 10,
              limitMs: 1_000,
              effectiveLimitMs: 1_000,
              deadlineAt: Date.now() + 1_000,
              warnings: [],
              handoff: {
                phase: spec.phase,
                successor: SubsystemPhase.nextAfterExpertPhase("bug-bounty", spec.phase),
                summary: `${spec.phase} complete`,
              },
              usage: usage.usage(),
              contextChurn: SubsystemUsage.contextChurn(usage.usage()),
              reasoningObservability: {
                items: 2,
                summaryItems: 0,
                contentItems: 0,
                deltaItems: 0,
                textStatus: "only counters received",
              },
              agentRun: {
                id: `run-${spec.phase}`,
                provider: "main-test",
                model: "gpt-5.4",
                providerAffinity: "main",
                promptManifest: prompt.manifest,
                childRunIDs: spec.phase === "recon" ? ["run-recon-child"] : [],
                skillsUsed: [],
                toolCalls: 0,
                fallbackAdmissions: 0,
                fallbackDescendants: 0,
              },
            }
          },
        },
      ),
    )

    const summary = JSON.parse(
      await readFile(path.join(workarea, "raw/operations/surface-coverage/recon.summary.json"), "utf8"),
    )
    expect(summary.route_families).toHaveLength(3)
    expect(summary.ui_action_families).toEqual(["navigation", "ui_input", "ui_interaction"])
    expect(usage.usage()).toMatchObject({ input: 160, output: 35, reasoning: 14 })
    expect(phases).toEqual(["brief", "recon", "exploit", "hacker", "verify", "report"])
    expect(personaIDs).toEqual([
      "bug-bounty/brief",
      "pentest/recon",
      "pentest/exploit",
      "pentest/hacker",
      "bug-bounty/verify",
      "bug-bounty/report",
    ])
    expect(systems.every((system) => system.startsWith("# Cyberful Instruction Authority"))).toBe(true)
    expect(systems.every((system) => system.includes("This is an authorized Bug Bounty Program session."))).toBe(true)
    expect(workflow).toMatchObject({ terminal: true, outcome: "success" })
  } finally {
    await rm(workarea, { recursive: true, force: true })
  }
})
