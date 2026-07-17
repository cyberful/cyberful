// ── Engagement Phase Runtime Tests ────────────────────────────────
// Verifies workflow identity, ordering, artifacts, budgets, orchestration,
// and phase-runner boundaries through real registry and Effect transitions.
// → cyberful/src/subsystem/phase.ts — owns workflow policy and ordering.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { SubsystemPhase } from "./phase"
import { SubsystemPhaseRunner, type PhaseDeps, type PhaseResult, type PhaseSpec } from "./phase-runner"
import { SubsystemOrchestrator } from "./orchestrator"
import { SubsystemProvider } from "./provider"
import type { SubsystemCli } from "./cli"
import { SessionID } from "@/session/schema"

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

// The registry is the single source of truth for the Codex chain. Unknown names remain outside the
// runtime instead of falling through to a generic Agent owner.
describe("Codex phase registry", () => {
  test("persisted Expert turns keep a session on the providerless Codex runtime", () => {
    expect(SubsystemPhase.listWorkflows()).not.toHaveLength(0)
    expect(SubsystemPhase.sessionUsesCodexRuntime("pentest", [{ role: "user", agent: "brief" }])).toBe(true)
    expect(
      SubsystemPhase.sessionUsesCodexRuntime("pentest", [
        { role: "assistant", agent: "brief" },
        { role: "user", agent: "exploit" },
      ]),
    ).toBe(true)
    expect(SubsystemPhase.sessionUsesCodexRuntime("pentest", [{ role: "user", agent: "ordinary-agent" }])).toBe(false)
  })

  test("persisted prefixed phase names resume through their renamed persona", () => {
    expect(SubsystemPhase.canonicalPhase("pentest", "pentest-exploit")).toBe("exploit")
    expect(SubsystemPhase.workflowOf("pentest-report")).toBe("pentest")
    expect(SubsystemPhase.personaPath("/tmp/agents/pentest", "pentest-verify")).toBe("/tmp/agents/pentest/verify.md")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "pentest-hacker")).toBe("verify")
  })

  test("every pentest phase is Expert-owned", () => {
    for (const p of ["brief", "recon", "exploit", "hacker", "verify", "report"])
      expect(SubsystemPhase.phaseOwner("pentest", p)).toBe("expert")
    expect(SubsystemPhase.phaseOwner("pentest", "pentest-recon")).toBe("unknown")
    expect(SubsystemPhase.phaseOwner("pentest", "small-worker")).toBe("unknown")
  })

  test("deliverableFor names every required Codex artifact; unknown phases have none", () => {
    expect(SubsystemPhase.deliverableFor("pentest", "brief")).toBe("MISSION.md")
    expect(SubsystemPhase.deliverableFor("pentest", "recon")).toBe("RECON.md")
    expect(SubsystemPhase.deliverableFor("pentest", "recon-consolidate")).toBeUndefined()
    expect(SubsystemPhase.deliverableFor("pentest", "exploit")).toBe("EXPLOIT.md")
    expect(SubsystemPhase.deliverableFor("pentest", "hacker")).toBe("HACKER.md")
    expect(SubsystemPhase.deliverableFor("pentest", "verify")).toBe("VERIFY.md")
    expect(SubsystemPhase.deliverableFor("pentest", "report")).toBe("REPORT.md")
    for (const p of ["pentest-recon", "small-worker"])
      expect(SubsystemPhase.deliverableFor("pentest", p)).toBeUndefined()
  })

  test("Expert phases advance positionally along the chain", () => {
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "brief")).toBe("recon")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "recon")).toBe("exploit")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "exploit")).toBe("hacker")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "hacker")).toBe("verify")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "verify")).toBe("report")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "report")).toBeUndefined()
  })

  test("budgetMinutesFor reads a phase's minutes, falling back when absent or invalid", () => {
    const b = { recon: 45, report: 30, bad: -5, alsoBad: "x" }
    expect(SubsystemPhase.budgetMinutesFor(b, "recon", 30)).toBe(45)
    expect(SubsystemPhase.budgetMinutesFor(b, "report", 30)).toBe(30)
    expect(SubsystemPhase.budgetMinutesFor(b, "missing", 12)).toBe(12) // absent → fallback
    expect(SubsystemPhase.budgetMinutesFor(b, "bad", 12)).toBe(12) // non-positive → fallback
    expect(SubsystemPhase.budgetMinutesFor(b, "alsoBad", 12)).toBe(12) // non-number → fallback
    expect(SubsystemPhase.budgetMinutesFor(undefined, "recon", 7)).toBe(7) // no/missing file → fallback
    expect(SubsystemPhase.resolveBudgetMinutes(b, "bad", 12)).toEqual({
      minutes: 12,
      warning: "Budget 'bad' is invalid; using 12 minutes.",
    })
  })

  test("container identity is stable, bounded, and distinct across projects and sessions", () => {
    const first = SubsystemPhase.expertContainerName(
      "/projects/alpha/work/a-very-long-security-engagement",
      "session-a",
    )
    expect(first).toBe(
      SubsystemPhase.expertContainerName("/projects/alpha/work/a-very-long-security-engagement", "session-a"),
    )
    expect(first).not.toBe(
      SubsystemPhase.expertContainerName("/projects/beta/work/a-very-long-security-engagement", "session-a"),
    )
    expect(first).not.toBe(
      SubsystemPhase.expertContainerName("/projects/alpha/work/a-very-long-security-engagement", "session-b"),
    )
    expect(first.length).toBeLessThanOrEqual(63)
    expect(first).toMatch(/^cyberful-os-expert-a-very-long-securit-[a-f0-9]{24}$/)
    expect(() => SubsystemPhase.expertContainerName("security", "session-a")).toThrow("absolute canonical workarea")
    expect(() => SubsystemPhase.expertContainerName("/projects/alpha/work/security", "")).toThrow("session id")
  })

  test("workflows are atomic named chains with one kickoff phase", () => {
    expect(SubsystemPhase.listWorkflows().map((m) => m.name)).toEqual([
      "pentest",
      "code-audit",
      "assessment",
      "remediate",
      "secure-review",
      "ask",
    ]) // selector source
    expect(SubsystemPhase.isWorkflow("pentest")).toBe(true)
    expect(SubsystemPhase.isWorkflow("code-audit")).toBe(true)
    expect(SubsystemPhase.workflowKickoffPhase("pentest")).toBe("brief") // TUI maps a workflow to its kickoff agent
    expect(SubsystemPhase.workflowKickoffPhase("code-audit")).toBe("scope")
    expect(SubsystemPhase.workflowKickoffPhase("assessment")).toBe("brief")
    expect(SubsystemPhase.workflowKickoffPhase("remediate")).toBe("intake")
    expect(SubsystemPhase.workflowKickoffPhase("secure-review")).toBe("map")
    expect(SubsystemPhase.workflowKickoffPhase("ask")).toBe("ask")
    expect(SubsystemPhase.workflowKickoffPhase("nope")).toBeUndefined()
    expect(SubsystemPhase.workflowOf("recon")).toBe("pentest") // globally unique phases can infer their workflow
    for (const shared of ["brief", "map", "verify", "report"]) expect(SubsystemPhase.workflowOf(shared)).toBeUndefined()
    expect(SubsystemPhase.workflowOf("pentest-recon")).toBeUndefined()
    expect(SubsystemPhase.workflowOf("small-worker")).toBeUndefined() // a non-phase agent belongs to no workflow
    // workflowForKickoffAgent considers only a workflow's first phase, unlike workflowOf.
    expect(SubsystemPhase.workflowForKickoffAgent("brief")).toBeUndefined() // Pentest and Assessment share it
    expect(SubsystemPhase.workflowForKickoffAgent("scope")).toBe("code-audit")
    expect(SubsystemPhase.workflowForKickoffAgent("intake")).toBe("remediate")
    expect(SubsystemPhase.workflowForKickoffAgent("map")).toBe("secure-review")
    expect(SubsystemPhase.workflowForKickoffAgent("ask")).toBe("ask")
    expect(SubsystemPhase.workflowForKickoffAgent("recon")).toBeUndefined() // in the chain but not the kickoff
    expect(SubsystemPhase.workflowForKickoffAgent("pentest-recon")).toBeUndefined()
  })

  test("each selectable workflow provides dedicated welcome prompt examples", () => {
    const workflows = SubsystemPhase.listWorkflows()
    expect(new Set(workflows.map((workflow) => workflow.promptPlaceholder.lead)).size).toBe(workflows.length)
    for (const workflow of workflows) {
      expect(workflow.promptPlaceholder.lead.trim()).not.toBe("")
      expect(workflow.promptPlaceholder.examples.length).toBeGreaterThan(0)
      expect(workflow.promptPlaceholder.examples.every((example) => example.trim().length > 0)).toBe(true)
    }
  })
})

// The runner's invocation is the security-relevant contract: autonomous under the phase policy, with
// the phase persona and the correctly-scoped gateway. Lock it with a captured fake spawn.
describe("phase runner contract", () => {
  const fixtureFile = async (filePath: string) => {
    if (filePath.endsWith("budgets.json")) return "{}"
    if (filePath.endsWith("instructions/cyberful.md"))
      return "<CYBERFUL INSTRUCTION>\nshared posture\n</CYBERFUL INSTRUCTION>"
    if (filePath.endsWith("recon.md")) return "# Recon persona"
    return "{}"
  }

  const fakeDeps = (capture: { input?: Parameters<typeof SubsystemCli.run>[0] }): PhaseDeps => ({
    run: async (input) => {
      capture.input = input
      return {
        stdout: JSON.stringify({
          method: "item/completed",
          params: { item: { type: "agentMessage", text: "phase done: wrote RECON.md" } },
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }
    },
    // Unused by the buffered tests (no onActivity); a trivial fake keeps the deps shape complete.
    runStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    provider: SubsystemProvider.codex,
    command: "codex",
    readFile: fixtureFile,
    ensureDirectory: async () => {},
  })

  test("recon runs autonomously under its policy, with its persona and the (proxy) gateway", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const res = await SubsystemPhaseRunner.runPhase(
      {
        phase: "recon",
        sessionID: "ses_1",
        workareaCwd: "/w",
        home: "/h",
        objective: "map the surface",
        timeoutMs: 1000,
      },
      fakeDeps(capture),
    )
    expect(res.ok).toBe(true)
    expect(res.summary).toContain("wrote RECON.md")
    const input = requireValue(capture.input, "phase runner did not invoke the captured Codex process")
    const spec = input.spec
    expect(spec.permission.kind).toBe("autonomous")
    expect(spec.developerInstructions).toContain("# Recon persona")
    expect(spec.developerInstructions).toContain("<CYBERFUL CODEX DELEGATION>")
    expect(spec.developerInstructions).toContain("shared posture")
    // Test environment uses the default xhigh effort, so positive persona metadata still fails closed.
    expect(spec.nativeSubagents).toBe(false)
    expect(spec.mcpServer?.name).toBe("expert-gateway")
    expect(spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_GATEWAY_PROXY).toBe("1")
    expect(input.spec.cwd).toBe("/w")
  })

  test("a phase's time budget (budgets.json) sets the runner timeout AND is told to the agent", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const deps: PhaseDeps = {
      ...fakeDeps(capture),
      // Path-aware fake: budgets.json carries the phase budget.
      readFile: async (p) => (p.endsWith("budgets.json") ? JSON.stringify({ recon: 45 }) : fixtureFile(p)),
    }
    await SubsystemPhaseRunner.runPhase(
      { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    // Persona/config setup consumes the same wall-clock envelope, so the subprocess receives the
    // remaining budget rather than a fresh full 45 minutes.
    const input = requireValue(capture.input, "budgeted phase did not invoke the captured Codex process")
    expect(input.timeoutMs).toBeLessThanOrEqual(45 * 60_000)
    expect(input.timeoutMs).toBeGreaterThan(45 * 60_000 - 100)
    expect(input.prompt).toContain("up to 45 minutes") // the agent is told, so it can use the time
    expect(input.prompt).toContain("Before your first tool call")
    expect(input.prompt).toContain("do not narrate every command")
  })

  test("a missing shared developer instruction fails before Codex starts", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const deps: PhaseDeps = {
      ...fakeDeps(capture),
      readFile: async (filePath) => {
        if (filePath.endsWith("budgets.json")) return "{}"
        if (filePath.endsWith("instructions/cyberful.md")) throw new Error("shared instruction missing")
        return "# Recon persona"
      },
    }
    const result = await SubsystemPhaseRunner.runPhase(
      { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("spawn_failed")
    expect(result.warnings.join(" ")).toContain("shared instruction missing")
    expect(capture.input).toBeUndefined()
  })

  test("invalid subagent frontmatter fails phase setup before Codex starts", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const deps: PhaseDeps = {
      ...fakeDeps(capture),
      readFile: async (filePath) => {
        if (filePath.endsWith("budgets.json")) return "{}"
        if (filePath.endsWith("instructions/cyberful.md")) return "shared posture"
        return "---\nsubagents: 1.5\n---\n# Recon persona"
      },
    }
    const result = await SubsystemPhaseRunner.runPhase(
      { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("spawn_failed")
    expect(result.warnings.join(" ")).toContain("subagents")
    expect(capture.input).toBeUndefined()
  })

  test("a non-zero exit or empty reply is not ok", async () => {
    const deps: PhaseDeps = {
      ...fakeDeps({}),
      run: async () => ({ stdout: "", stderr: "boom", exitCode: 127, timedOut: false }),
    }
    const res = await SubsystemPhaseRunner.runPhase(
      { phase: "brief", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    expect(res.ok).toBe(false)
  })

  test("with an observer it streams: sets spec.stream and forwards mapped activity items in order", async () => {
    const activities: SubsystemProvider.PhaseActivity[] = []
    let streamedSpec: Parameters<typeof SubsystemCli.runStreaming>[0]["spec"] | undefined
    const deps: PhaseDeps = {
      ...fakeDeps({}),
      runStreaming: async (input, onEvent) => {
        streamedSpec = input.spec
        // Events the Codex app-server emits: an assistant message and an MCP tool call.
        onEvent({
          method: "item/completed",
          params: { item: { id: "msg-1", type: "agentMessage", text: "mapping the surface" } },
        })
        onEvent({
          method: "item/started",
          params: { item: { id: "call-1", type: "mcpToolCall", tool: "browser_navigate", arguments: {} } },
        })
        return {
          stdout: JSON.stringify({
            method: "item/completed",
            params: { item: { type: "agentMessage", text: "phase done" } },
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }
      },
      onActivity: (a) => activities.push(a),
    }
    const res = await SubsystemPhaseRunner.runPhase(
      { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    expect(res.ok).toBe(true)
    expect(streamedSpec?.stream).toBe(true)
    // Mapped by the real provider.streamActivities and delivered in stream order.
    expect(activities).toEqual([
      { kind: "text", text: "mapping the surface" },
      { kind: "tool", tool: "browser_navigate", input: {}, callID: "call-1" },
    ])
  })

  test("keeps gateway routing and ZAP keys out of the Codex process environment", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    await SubsystemPhaseRunner.runPhase(
      {
        phase: "recon",
        sessionID: "ses_1",
        workareaCwd: "/w",
        home: "/h",
        objective: "x",
        timeoutMs: 1000,
        env: {
          CYBER_BROWSER_HEADLESS: "true",
          CYBER_ZAP_API_KEY: "engagement-secret",
        },
      },
      fakeDeps(capture),
    )

    const input = requireValue(capture.input, "private-environment phase did not invoke the captured Codex process")
    expect(input.spec.env?.CYBER_BROWSER_HEADLESS).toBeUndefined()
    expect(input.spec.env?.CYBER_ZAP_API_KEY).toBeUndefined()
    expect(input.spec.mcpServer?.privateEnv?.CYBER_BROWSER_HEADLESS).toBe("true")
    expect(input.spec.mcpServer?.privateEnv?.CYBER_ZAP_API_KEY).toBe("engagement-secret")
  })
})

// The orchestrator walks one sequential Codex-only chain. Recon is an ordinary phase whose native
// subagents, when enabled, remain descendants of that one process and do not create a host-side branch.
describe("phase orchestration (runAndAdvance)", () => {
  const completedPhase = (phase: string): PhaseResult => ({
    phase,
    ok: true,
    summary: `${phase} done`,
    exitCode: 0,
    timedOut: false,
    termination: "completed",
    backend: "codex",
    durationMs: 100,
    limitMs: 60_000,
    effectiveLimitMs: 60_000,
    deadlineAt: 60_000,
    warnings: [],
    handoff: { phase, successor: SubsystemPhase.nextAfterExpertPhase("pentest", phase), summary: `${phase} done` },
  })
  const baseInput = (startPhase: string) => ({
    workflow: "pentest",
    sessionID: SessionID.make("ses_1"),
    startPhase,
    objective: "kickoff",
    workareaCwd: "/w",
    home: "/h",
    path: { cwd: "/c", root: "/r" },
    timeoutMs: 1000,
  })

  test("brief reaches report through six sequential Codex phases", async () => {
    const phases: string[] = []
    const specs: PhaseSpec[] = []
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("brief"), {
        runPhase: async (spec) => {
          phases.push(spec.phase)
          specs.push(spec)
          return completedPhase(spec.phase)
        },
      }),
    )
    expect(phases).toEqual(["brief", "recon", "exploit", "hacker", "verify", "report"])
    expect(out.ranPhases).toEqual(phases)
    expect(out.terminal).toBe(true)
    expect(out.status).toBe("completed")
    expect(specs.map((spec) => [spec.phase, spec.handoff?.successor])).toEqual([
      ["brief", "recon"],
      ["recon", "exploit"],
      ["exploit", "hacker"],
      ["hacker", "verify"],
      ["verify", "report"],
      ["report", undefined],
    ])
  })

  test("the Recon summary seeds Exploit in a fresh Codex context", async () => {
    const specs: PhaseSpec[] = []
    await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => {
          specs.push(spec)
          return spec.phase === "recon"
            ? { ...completedPhase(spec.phase), summary: "Recon wrote the authoritative RECON.md" }
            : completedPhase(spec.phase)
        },
      }),
    )
    expect(specs.find((spec) => spec.phase === "exploit")?.objective).toContain("RECON.md")
  })

  test("a provider failure or rejection halts before the successor", async () => {
    const failed = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => ({
          ...completedPhase(spec.phase),
          ok: false,
          exitCode: 1,
          termination: "provider_failed",
          warnings: ["failed"],
        }),
      }),
    )
    expect(failed.haltedAt).toBe("recon")
    expect(failed.terminal).toBe(false)

    const rejected = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("verify"), {
        runPhase: async () => {
          throw new Error("adapter rejected")
        },
      }),
    )
    expect(rejected.haltedAt).toBe("verify")
    expect(rejected.summary).toContain("adapter rejected")
  })

  test("interrupting Recon aborts the exact signal passed to its one phase process", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const fiber = Effect.runFork(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: (spec) =>
          new Promise((resolve) => {
            const abort = requireValue(spec.abort, "orchestrator did not provide an abort signal to the phase")
            started.resolve(abort)
            abort.addEventListener("abort", () => resolve(completedPhase(spec.phase)), { once: true })
          }),
      }),
    )
    const signal = await started.promise
    expect(signal.aborted).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(signal.aborted).toBe(true)
  })

  test("an early warning remains degraded through a clean terminal report", async () => {
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("brief"), {
        runPhase: async (spec) =>
          spec.phase === "recon"
            ? { ...completedPhase(spec.phase), warnings: ["partial passive coverage"] }
            : completedPhase(spec.phase),
      }),
    )
    expect(out.terminal).toBe(true)
    expect(out.status).toBe("completed_with_warnings")
  })

  test("propagates the terminal completion proposal to the host boundary", async () => {
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("report"), {
        runPhase: async (spec) => {
          const result = completedPhase(spec.phase)
          const handoff = requireValue(result.handoff, `completed ${spec.phase} phase did not include a handoff`)
          return {
            ...result,
            handoff: {
              ...handoff,
              completion: {
                title: "Authorized assessment completed",
                summaryMarkdown: "The report is ready.",
                artifacts: [{ label: "Report", path: "reports/security-report.pdf" }],
              },
            },
          }
        },
      }),
    )
    expect(out.completion).toEqual({
      title: "Authorized assessment completed",
      summaryMarkdown: "The report is ready.",
      artifacts: [{ label: "Report", path: "reports/security-report.pdf" }],
    })
  })
})
