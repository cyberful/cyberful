// ── Local Bug Bounty Workflow E2E ───────────────────────────────
// Exercises the research contracts together without target traffic: browser
//   coverage, causal pivots, child usage, effort evidence, and full handoff.
// → cyberful/src/subsystem/orchestrator.ts — owns sequential advancement.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionID } from "@/session/schema"
import { NoveltyLedger } from "./gateway/novelty-ledger"
import { SurfaceCoverage } from "./gateway/surface-coverage"
import { SubsystemOrchestrator } from "./orchestrator"
import { SubsystemPhase } from "./phase"
import type { PhaseResult } from "./phase-runner"
import { SubsystemUsage } from "./usage"

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

function hypothesis(id: string, rootCause: string, sourceID?: string) {
  return {
    id,
    title: `${rootCause} boundary`,
    root_cause: rootCause,
    enforcement_owner: `${rootCause} service`,
    protocol: rootCause === "workflow race" ? "websocket" : "https",
    state_transition: `observe ${rootCause} before and after a target state change`,
    attacker_capability: "ordinary authenticated tester",
    oracle: `differential response for ${rootCause}`,
    target_facts: [`Target exposes a ${rootCause} transition.`],
    ...(sourceID ? { source_ref: { phase: "recon", kind: "coverage_backlog", id: sourceID } } : {}),
  }
}

test("local Bug Bounty path combines broad navigation, causal pivots, child usage, and complete handoff", async () => {
  const workarea = await mkdtemp(path.join(os.tmpdir(), "cyberful-bounty-e2e-"))
  try {
    const coverage = new SurfaceCoverage(workarea, "recon")
    await coverage.observe(browserResult("browser_navigate", "navigation", "/dashboard"))
    await coverage.observe(browserResult("browser_click", "ui_interaction", "/settings/security"))
    await coverage.observe(browserResult("browser_type", "ui_input", "/trade/order", 2))
    await coverage.close()

    const pivots = [
      ["recon", hypothesis("RC-1", "authorization graph")],
      ["exploit", hypothesis("EX-1", "workflow race", "RC-COV-1")],
      ["hacker", hypothesis("HK-1", "key custody seam")],
    ] as const
    for (const [phase, entry] of pivots) {
      const ledger = new NoveltyLedger(workarea, phase, { required: true })
      await ledger.record(entry)
      await ledger.synthesize({
        outcome: "diversified",
        contrarian_summary: `${phase} pivoted to a target-specific causal boundary.`,
        evidence: [`${entry.id} uses ${entry.protocol} and ${entry.enforcement_owner}.`],
        remaining_unknowns: [],
      })
      expect(await ledger.handoffError()).toBeUndefined()
    }

    const usage = SubsystemUsage.createSessionCounter()
    usage.observe({}, { scopeID: "root", generatedTokens: 20, inputTokens: 100, reasoningTokens: 8 })
    usage.observe({}, { scopeID: "subagent-01", generatedTokens: 15, inputTokens: 60, reasoningTokens: 6 })

    const phases: string[] = []
    const workflow = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        {
          workflow: "bug-bounty",
          sessionID: SessionID.make("ses_bounty_e2e"),
          startPhase: "brief",
          objective: "local contract exercise",
          workareaCwd: workarea,
          home: workarea,
          path: { cwd: workarea, root: workarea },
          timeoutMs: 1_000,
        },
        {
          runPhase: async (spec): Promise<PhaseResult> => {
            phases.push(spec.phase)
            return {
              phase: spec.phase,
              ok: true,
              summary: `${spec.phase} complete`,
              exitCode: 0,
              timedOut: false,
              termination: "completed",
              backend: "codex",
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
              codexSettings: { requestedEffort: "ultra", resolvedEffort: "ultra", attested: true },
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
    expect(workflow).toMatchObject({ terminal: true, status: "completed" })
  } finally {
    await rm(workarea, { recursive: true, force: true })
  }
})
