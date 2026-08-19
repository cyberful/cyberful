// ── Engagement Phase Runtime Tests ────────────────────────────────
// Verifies workflow identity, ordering, artifacts, budgets, orchestration,
// and phase-runner boundaries through real registry and Effect transitions.
// → cyberful/src/subsystem/phase.ts — owns workflow policy and ordering.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Type } from "typebox"
import { Settings } from "@/config/settings"
import { SubsystemPhase } from "./phase"
import { SubsystemPhaseRunner, type PhaseDeps, type PhaseResult, type PhaseSpec } from "./phase-runner"
import { SubsystemOrchestrator } from "./orchestrator"
import { Subsystem } from "./subsystem"
import type { SubsystemCli } from "./cli"
import { SessionID } from "@/session/schema"
import type { SkillRegistry } from "./pi-skills"

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

const TEST_SETTINGS = Settings.parse(Settings.DEFAULT_YAML, "test-settings.yaml")
const EMPTY_SKILL_PARAMETERS = Type.Object(
  {
    skill: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
const EMPTY_SKILLS = {
  catalog: [],
  searchTool: {
    name: "skill_search",
    label: "Search trusted skills",
    description: "No skills are configured in this isolated phase test.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 20, pattern: "^(0|[1-9][0-9]*)$" })),
    }),
    execute: async () => ({
      content: [{ type: "text" as const, text: "{}" }],
      details: { query: "*", total: 0, returned: 0 },
    }),
  },
  tool: {
    name: "skill_read",
    label: "Read trusted skill",
    description: "No skills are configured in this isolated phase test.",
    parameters: EMPTY_SKILL_PARAMETERS,
    execute: async () => {
      throw new Error("no test skills are configured")
    },
  },
  stageTool: {
    name: "skill_stage",
    label: "Stage trusted skill resource",
    description: "No skills are configured in this isolated phase test.",
    parameters: Type.Object({ skill: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) }),
    execute: async () => {
      throw new Error("no test skills are configured")
    },
  },
  read: async () => {
    throw new Error("no test skills are configured")
  },
} satisfies SkillRegistry

// The registry is the single source of truth for the Pi chain. Unknown names remain outside the
// runtime instead of falling through to a generic Agent owner.
describe("Pi phase registry", () => {
  test("persisted Expert turns keep a session on the configured Pi runtime", () => {
    expect(SubsystemPhase.listWorkflows()).not.toHaveLength(0)
    expect(SubsystemPhase.sessionUsesAgentRuntime("pentest", [{ role: "user", agent: "brief" }])).toBe(true)
    expect(
      SubsystemPhase.sessionUsesAgentRuntime("pentest", [
        { role: "assistant", agent: "brief" },
        { role: "user", agent: "exploit" },
      ]),
    ).toBe(true)
    expect(SubsystemPhase.sessionUsesAgentRuntime("pentest", [{ role: "user", agent: "ordinary-agent" }])).toBe(false)
  })

  test("phase names are direct and workflow-scoped", () => {
    expect(SubsystemPhase.canonicalPhase("pentest", "exploit")).toBe("exploit")
    expect(SubsystemPhase.workflowOf("pentest-report")).toBeUndefined()
    expect(SubsystemPhase.personaPath("/tmp/agents/pentest", "verify")).toBe("/tmp/agents/pentest/verify.md")
    expect(SubsystemPhase.nextAfterExpertPhase("pentest", "hacker")).toBe("verify")
  })

  test("every pentest phase is Expert-owned", () => {
    for (const p of ["brief", "recon", "exploit", "hacker", "verify", "report"])
      expect(SubsystemPhase.phaseOwner("pentest", p)).toBe("expert")
    expect(SubsystemPhase.phaseOwner("pentest", "pentest-recon")).toBe("unknown")
    expect(SubsystemPhase.phaseOwner("pentest", "small-worker")).toBe("unknown")
  })

  test("deliverableFor names every required Pi phase artifact; unknown phases have none", () => {
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

  test("closeout reserves are bounded and legacy budgets degrade visibly", () => {
    expect(SubsystemPhase.resolveCloseoutMinutes({ brief: 30, $closeout: { brief: 5 } }, "brief", 30)).toEqual({
      minutes: 5,
    })
    expect(SubsystemPhase.resolveCloseoutMinutes({ brief: 30 }, "brief", 30)).toEqual({ minutes: 3 })
    expect(SubsystemPhase.resolveCloseoutMinutes({ recon: 60 }, "recon", 60)).toEqual({ minutes: 5 })
    expect(SubsystemPhase.resolveCloseoutMinutes({ ask: 30 }, "ask", 30)).toEqual({ minutes: 0 })
    expect(SubsystemPhase.resolveCloseoutMinutes({ brief: 4, $closeout: { brief: 5 } }, "brief", 4)).toEqual({
      minutes: 2,
      warning:
        "Closeout 'brief' is invalid; using 2 minutes. Closeout 'brief' reduced to 2 minutes because it must be shorter than the 4-minute phase budget.",
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

  test("the selectable workflows are atomic named chains with one kickoff phase", () => {
    expect(SubsystemPhase.listWorkflows().map((m) => m.name)).toEqual(["pentest", "bug-bounty", "code-audit"])
    expect(SubsystemPhase.isWorkflow("pentest")).toBe(true)
    expect(SubsystemPhase.isWorkflow("bug-bounty")).toBe(true)
    expect(SubsystemPhase.isWorkflow("code-audit")).toBe(true)
    expect(SubsystemPhase.isWorkflow("ask")).toBe(false)
    expect(SubsystemPhase.workflow("ask")?.kind).toBe("interactive")
    expect(SubsystemPhase.workflowKickoffPhase("pentest")).toBe("brief") // TUI maps a workflow to its kickoff agent
    expect(SubsystemPhase.workflowKickoffPhase("bug-bounty")).toBe("brief")
    expect(SubsystemPhase.workflowKickoffPhase("code-audit")).toBe("scope")
    expect(SubsystemPhase.workflowKickoffPhase("ask")).toBe("ask") // internal post-completion follow-up
    expect(SubsystemPhase.workflowKickoffPhase("nope")).toBeUndefined()
    expect(SubsystemPhase.workflowOf("recon")).toBe("pentest") // legacy Pentest-only rows keep their old inference
    expect(SubsystemPhase.workflowOf("brief")).toBe("pentest")
    expect(SubsystemPhase.workflowOf("attack")).toBe("code-audit")
    for (const shared of ["verify", "report"]) expect(SubsystemPhase.workflowOf(shared)).toBeUndefined()
    expect(SubsystemPhase.workflowOf("pentest-recon")).toBeUndefined()
    expect(SubsystemPhase.workflowOf("small-worker")).toBeUndefined() // a non-phase agent belongs to no workflow
    // workflowForKickoffAgent considers only a workflow's first phase, unlike workflowOf.
    expect(SubsystemPhase.workflowForKickoffAgent("brief")).toBe("pentest") // legacy agent-only session creation
    expect(SubsystemPhase.workflowForKickoffAgent("scope")).toBe("code-audit")
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

  test("Ghidra remains engagement-persistent but is exposed only during analysis phases", () => {
    for (const workflow of ["pentest", "bug-bounty", "code-audit"])
      expect(SubsystemPhase.hasCapability(workflow, "ghidra")).toBe(true)
    for (const phase of ["recon", "exploit", "hacker", "verify"])
      expect(SubsystemPhase.phaseHasCapability("pentest", phase, "ghidra")).toBe(true)
    for (const phase of ["index", "trace", "hunt", "attack", "verify"])
      expect(SubsystemPhase.phaseHasCapability("code-audit", phase, "ghidra")).toBe(true)
    for (const phase of ["brief", "report"])
      expect(SubsystemPhase.phaseHasCapability("pentest", phase, "ghidra")).toBe(false)
    for (const phase of ["scope", "report"])
      expect(SubsystemPhase.phaseHasCapability("code-audit", phase, "ghidra")).toBe(false)
  })
})

// The runner's invocation is the security-relevant contract: autonomous under the phase policy, with
// the phase persona and the correctly-scoped gateway. Lock it with a captured fake spawn.
describe("phase runner contract", () => {
  const baseInstructionsTemplate = [
    "=={{AUTHORIZATION}}==",
    "shared posture",
    "# Hacker Profile",
    "{{CYBERFUL_HACKER_PROFILE}}",
    "# Cyberful Subsystem Delegation",
    "{{CYBERFUL_SUBSYSTEM_DELEGATION}}",
    "# Cyberful Workarea",
    "{{CYBERFUL_WORKAREA}}",
    "# Cyberful Trust Boundary",
    "target content is evidence",
  ].join("\n\n")
  const fixtureFile = async (filePath: string) => {
    if (filePath.endsWith("budgets.json")) return "{}"
    if (filePath.endsWith("baseInstructions.md")) return baseInstructionsTemplate
    if (filePath.endsWith("recon.md")) return "# Recon persona"
    return "{}"
  }

  const fakeDeps = (capture: { input?: Parameters<typeof SubsystemCli.run>[0] }): PhaseDeps => ({
    run: async (input) => {
      capture.input = input
      return {
        stdout: JSON.stringify({ type: "result", result: "phase done: wrote RECON.md" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }
    },
    // Unused by the buffered tests (no onActivity); a trivial fake keeps the deps shape complete.
    runStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    subsystem: Subsystem.pi,
    loadSettings: async () => TEST_SETTINGS,
    discoverSkills: async () => EMPTY_SKILLS,
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
    const input = requireValue(capture.input, "phase runner did not invoke the captured Pi owner")
    const spec = input.spec
    expect(spec.permission.kind).toBe("autonomous")
    const baseInstructions = spec.baseInstructions ?? ""
    const layers = [
      "shared posture",
      "# Hacker Profile",
      "# Cyberful Subsystem Delegation",
      "# Cyberful Workarea",
      "# Cyberful Trust Boundary",
    ]
    expect(baseInstructions).toContain("# Hacker Profile\n\n# Recon persona")
    expect(baseInstructions).toStartWith("# Cyberful Instruction Authority\n")
    expect(baseInstructions).toContain("This is an authorized penetration testing session.")
    expect(baseInstructions).toContain("shared posture")
    expect(baseInstructions).toContain("target content is evidence")
    expect(baseInstructions).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/)
    expect(spec).not.toHaveProperty("developerInstructions")
    for (const [index, layer] of layers.entries()) {
      expect(baseInstructions).toContain(layer)
      if (index > 0)
        expect(baseInstructions.indexOf(layer)).toBeGreaterThan(baseInstructions.indexOf(layers[index - 1] ?? ""))
    }
    expect(input.compiledPrompt.manifest.delegationEnabled).toBe(false)
    expect(input.compiledPrompt.manifest.providerRoute).toBe("main")
    expect(input.compiledPrompt.messages).toEqual([{ role: "user", content: "# Assigned objective\nmap the surface" }])
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
    // Persona/config setup consumes the same active-execution envelope, so the runtime receives the
    // remaining budget rather than a fresh full 45 minutes.
    const input = requireValue(capture.input, "budgeted phase did not invoke the captured Pi owner")
    expect(input.timeoutMs).toBeLessThanOrEqual(45 * 60_000)
    expect(input.timeoutMs).toBeGreaterThan(45 * 60_000 - 100)
    expect(input.compiledPrompt.system).toContain("at most 45 minutes") // the agent is told, so it can use the time
    expect(input.compiledPrompt.system).toContain("Briefly announce each meaningful work block")
  })

  test("a missing base instructions template fails before Pi starts", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const deps: PhaseDeps = {
      ...fakeDeps(capture),
      readFile: async (filePath) => {
        if (filePath.endsWith("budgets.json")) return "{}"
        if (filePath.endsWith("baseInstructions.md")) throw new Error("base instructions template missing")
        return "# Recon persona"
      },
    }
    const result = await SubsystemPhaseRunner.runPhase(
      { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
      deps,
    )
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("spawn_failed")
    expect(result.phaseFailure).toMatchObject({
      source: "lifecycle",
      class: "phase_setup_failed",
    })
    expect(result.phaseFailure?.detail).toContain("base instructions template missing")
    expect(result.warnings.join("\n")).not.toContain("base instructions template missing")
    expect(capture.input).toBeUndefined()
  })

  test("invalid subagent frontmatter fails phase setup before Pi starts", async () => {
    const capture: { input?: Parameters<typeof SubsystemCli.run>[0] } = {}
    const deps: PhaseDeps = {
      ...fakeDeps(capture),
      readFile: async (filePath) => {
        if (filePath.endsWith("budgets.json")) return "{}"
        if (filePath.endsWith("baseInstructions.md")) return baseInstructionsTemplate
        return "---\nsubagents: 1.5\n---\n# Recon persona"
      },
    }
    await expect(
      SubsystemPhaseRunner.runPhase(
        { phase: "recon", sessionID: "s", workareaCwd: "/w", home: "/h", objective: "x", timeoutMs: 1000 },
        deps,
      ),
    ).rejects.toThrow("subagents")
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

  test("with an observer it streams Pi activity items in order", async () => {
    const activities: Subsystem.PhaseActivity[] = []
    let streamedInput: Parameters<typeof SubsystemCli.runStreaming>[0] | undefined
    const deps: PhaseDeps = {
      ...fakeDeps({}),
      runStreaming: async (input, onEvent) => {
        streamedInput = input
        onEvent({
          type: "activity",
          runID: "root",
          activity: { kind: "text", text: "mapping the surface" },
        })
        onEvent({
          type: "activity",
          runID: "root",
          activity: { kind: "tool", tool: "browser_navigate", input: {}, callID: "call-1" },
        })
        return {
          stdout: JSON.stringify({ type: "result", result: "phase done" }),
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
    expect(streamedInput?.compiledPrompt.manifest.role).toBe("root")
    expect(activities).toEqual([
      { kind: "text", text: "mapping the surface" },
      { kind: "tool", tool: "browser_navigate", input: {}, callID: "call-1" },
    ])
  })

  test("keeps gateway routing and ZAP keys out of Pi messages", async () => {
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
          CYBERFUL_SOURCE_STORE_ROOT: "/host/source-store",
          CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY: "host-import-attestation-secret",
        },
      },
      fakeDeps(capture),
    )

    const input = requireValue(capture.input, "private-environment phase did not invoke the captured Pi owner")
    const providerMessages = `${input.compiledPrompt.system}\n${input.compiledPrompt.messages
      .map((message) => message.content)
      .join("\n")}`
    expect(providerMessages).not.toContain("engagement-secret")
    expect(providerMessages).not.toContain("host-import-attestation-secret")
    expect(providerMessages).not.toContain("/host/source-store")
    expect(input.spec.mcpServer?.privateEnv?.CYBER_BROWSER_HEADLESS).toBe("true")
    expect(input.spec.mcpServer?.privateEnv?.CYBER_ZAP_API_KEY).toBe("engagement-secret")
    expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SOURCE_STORE_ROOT).toBe("/host/source-store")
    expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY).toBe(
      "host-import-attestation-secret",
    )
  })
})

// The orchestrator walks one sequential Pi chain. Delegated and fallback runs
// remain inside the active in-process phase owner and never create host-side phase fan-out.
describe("phase orchestration (runAndAdvance)", () => {
  const completedPhase = (phase: string): PhaseResult => ({
    phase,
    ok: true,
    summary: `${phase} done`,
    exitCode: 0,
    timedOut: false,
    termination: "completed",
    backend: "pi",
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
    settingsDirectory: "/settings",
    path: { cwd: "/c", root: "/r" },
    timeoutMs: 1000,
  })

  test("brief reaches report through six sequential Pi phases", async () => {
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
    expect(out.outcome).toBe("success")
    expect(specs.map((spec) => [spec.phase, spec.handoff?.successor])).toEqual([
      ["brief", "recon"],
      ["recon", "exploit"],
      ["exploit", "hacker"],
      ["hacker", "verify"],
      ["verify", "report"],
      ["report", undefined],
    ])
  })

  test("the Recon summary seeds Exploit in a fresh Pi context", async () => {
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

  test("a subsystem failure or rejection halts before the successor", async () => {
    const failed = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => ({
          ...completedPhase(spec.phase),
          ok: false,
          exitCode: 1,
          termination: "subsystem_failed",
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

  test("a retryable provider failure restarts the phase once on the configured fallback route", async () => {
    const specs: PhaseSpec[] = []
    let reconAttempts = 0
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && reconAttempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "unavailable",
                  providerCode: "server_is_overloaded",
                  retryable: true,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "unavailable",
                  code: "server_is_overloaded",
                  detail: "provider overloaded",
                },
                approvalWaitMs: 2_000,
                retryWaitMs: 12_000,
                targetCooldownWaitMs: 180_000,
                retryCompensationMs: 10_000,
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: true,
                },
              }
            return {
              ...completedPhase(spec.phase),
              agentRun: {
                id: `${spec.phase}-${spec.attempt ?? 1}`,
                provider: spec.providerRoute === "fallback" ? "fallback" : "main",
                model: "test",
                providerAffinity: spec.providerRoute ?? "main",
                promptManifest: {} as NonNullable<PhaseResult["agentRun"]>["promptManifest"],
                childRunIDs: [],
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

    expect(specs.slice(0, 2).map((spec) => [spec.phase, spec.attempt, spec.providerRoute])).toEqual([
      ["recon", 1, "main"],
      ["recon", 2, "fallback"],
    ])
    expect(specs[1]?.objective).toContain("Do not repeat an operation")
    expect(specs[1]?.timeoutMs).toBe(359_900)
    expect(specs[1]?.budgetCarry).toMatchObject({
      approvalWaitMs: 2_000,
      retryWaitMs: 12_000,
      targetCooldownWaitMs: 180_000,
      phaseExtensionMs: 10_000,
      recoveryExtensionMs: 300_000,
    })
    expect(specs[1]?.budgetCarry?.recoveryChainIDs).toHaveLength(1)
    expect(out.phaseAttempts.slice(0, 2).map((attempt) => [attempt.phase, attempt.attempt, attempt.recovered])).toEqual(
      [
        ["recon", 1, true],
        ["recon", 2, false],
      ],
    )
    expect(out.terminal).toBe(true)
    expect(out.outcome).toBe("warning")
  })

  test("a main-provider policy block restarts the same phase once on fallback", async () => {
    const specs: PhaseSpec[] = []
    let attempts = 0
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && attempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "security_policy_block",
                  providerCode: "cyberPolicy",
                  retryable: false,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "security_policy_block",
                  code: "cyberPolicy",
                  detail: "main route rejected the request",
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: true,
                },
              }
            return completedPhase(spec.phase)
          },
        },
      ),
    )

    expect(specs.slice(0, 2).map((spec) => [spec.phase, spec.attempt, spec.providerRoute])).toEqual([
      ["recon", 1, "main"],
      ["recon", 2, "fallback"],
    ])
    expect(specs[1]?.objective).toContain("security_policy_block")
    expect(out.terminal).toBe(true)
    expect(out.outcome).toBe("warning")
  })

  test("a Pentest policy block without fallback retries once on main with the recorded client authorization", async () => {
    const specs: PhaseSpec[] = []
    let attempts = 0
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && attempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "security_policy_block",
                  providerCode: "cyberPolicy",
                  retryable: false,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "security_policy_block",
                  code: "cyberPolicy",
                  detail: "main route rejected the request",
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: false,
                  automaticSecurityBlockEnabled: false,
                },
              }
            return completedPhase(spec.phase)
          },
          resolveClientName: async () => "Acme Security S.p.A.",
        },
      ),
    )

    expect(specs.slice(0, 2).map((spec) => [spec.attempt, spec.providerRoute])).toEqual([
      [1, "main"],
      [2, "main"],
    ])
    expect(specs[1]?.objective).toContain('client recorded as "Acme Security S.p.A."')
    expect(specs[1]?.objective).toContain("commissioned and authorized this penetration test")
    expect(specs[1]?.objective).toContain("It grants no new target, method, effect, credential use, or authority")
    expect(out.outcome).toBe("warning")
  })

  test("a Bug Bounty policy block without fallback retries once on main with program authorization", async () => {
    const specs: PhaseSpec[] = []
    let attempts = 0
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), workflow: "bug-bounty", timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && attempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "security_policy_block",
                  providerCode: "cyberPolicy",
                  retryable: false,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "security_policy_block",
                  code: "cyberPolicy",
                  detail: "main route rejected the request",
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: false,
                  automaticSecurityBlockEnabled: false,
                },
              }
            return {
              ...completedPhase(spec.phase),
              handoff: {
                phase: spec.phase,
                successor: SubsystemPhase.nextAfterExpertPhase("bug-bounty", spec.phase),
                summary: `${spec.phase} done`,
              },
            }
          },
        },
      ),
    )

    expect(specs.slice(0, 2).map((spec) => [spec.attempt, spec.providerRoute])).toEqual([
      [1, "main"],
      [2, "main"],
    ])
    expect(specs[1]?.objective).toContain("authorized Bug Bounty Program")
    expect(specs[1]?.objective).toContain("supplied program policy and recorded engagement scope")
    expect(out.outcome).toBe("warning")
  })

  test("a fallback-provider policy block is terminal and never returns to main", async () => {
    const specs: PhaseSpec[] = []
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => {
          specs.push(spec)
          return {
            ...completedPhase(spec.phase),
            ok: false,
            summary: "",
            exitCode: 1,
            termination: "subsystem_failed",
            handoff: undefined,
            subsystemFailure: {
              kind: "security_policy_block",
              providerCode: "cyberPolicy",
              retryable: false,
            },
            phaseFailure: {
              phase: spec.phase,
              source: "provider",
              class: "security_policy_block",
              code: "cyberPolicy",
              detail: "fallback route rejected the request",
            },
            recoveryPolicy: {
              enabled: true,
              maxRestarts: 1,
              useFallbackProvider: true,
              fallbackConfigured: true,
            },
          }
        },
      }),
    )

    expect(specs.map((spec) => spec.providerRoute)).toEqual(["main", "fallback"])
    expect(out.haltedAt).toBe("recon")
    expect(out.outcome).toBe("failed")
  })

  test("a retryable required-upstream failure restarts once without changing provider route", async () => {
    const specs: PhaseSpec[] = []
    let attempts = 0
    await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && attempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                exitCode: 127,
                termination: "spawn_failed",
                handoff: undefined,
                phaseFailure: {
                  phase: spec.phase,
                  source: "upstream",
                  class: "required_upstream_unavailable",
                  detail: "ZAP preflight failed",
                  retryable: true,
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: true,
                },
              }
            return completedPhase(spec.phase)
          },
        },
      ),
    )
    expect(specs.slice(0, 2).map((spec) => [spec.attempt, spec.providerRoute])).toEqual([
      [1, "main"],
      [2, "main"],
    ])
    expect(specs[1]?.objective).toContain("required-upstream")
  })

  test("a hard context tail restarts once on the same route and reconciles hypotheses", async () => {
    const specs: PhaseSpec[] = []
    let reconAttempts = 0
    await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && reconAttempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "capacity",
                  providerCode: "active_tail_too_large",
                  retryable: true,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "capacity",
                  code: "active_tail_too_large",
                  detail: "minimal context reached the hard input limit",
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: true,
                },
              }
            return completedPhase(spec.phase)
          },
        },
      ),
    )

    expect(specs.slice(0, 2).map((spec) => [spec.phase, spec.attempt, spec.providerRoute])).toEqual([
      ["recon", 1, "main"],
      ["recon", 2, "main"],
    ])
    expect(specs[1]?.objective).toContain("list the current hypothesis registry")
  })

  test("a tool-call history mismatch restarts once on main without requiring fallback", async () => {
    const specs: PhaseSpec[] = []
    let reconAttempts = 0
    await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(
        { ...baseInput("recon"), timeoutMs: 60_000 },
        {
          runPhase: async (spec) => {
            specs.push(spec)
            if (spec.phase === "recon" && reconAttempts++ === 0)
              return {
                ...completedPhase(spec.phase),
                ok: false,
                summary: "",
                exitCode: 1,
                termination: "subsystem_failed",
                handoff: undefined,
                subsystemFailure: {
                  kind: "malformed_output",
                  providerCode: "tool_call_history_mismatch",
                  retryable: true,
                },
                phaseFailure: {
                  phase: spec.phase,
                  source: "provider",
                  class: "malformed_output",
                  code: "tool_call_history_mismatch",
                  detail: "provider conversation lost a completed tool-call pair",
                },
                recoveryPolicy: {
                  enabled: true,
                  maxRestarts: 1,
                  useFallbackProvider: true,
                  fallbackConfigured: false,
                },
              }
            return completedPhase(spec.phase)
          },
        },
      ),
    )

    expect(specs.slice(0, 2).map((spec) => [spec.phase, spec.attempt, spec.providerRoute])).toEqual([
      ["recon", 1, "main"],
      ["recon", 2, "main"],
    ])
    expect(specs[1]?.objective).toContain("tool_call_history_mismatch")
    expect(specs[1]?.objective).toContain("Do not repeat an operation")
  })

  test("terminal contract failures are failed while a plain interruption is blocked", async () => {
    const contractFailure = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => ({
          ...completedPhase(spec.phase),
          ok: false,
          handoff: undefined,
          exitCode: 1,
          termination: "budget_exhausted",
          phaseFailure: {
            phase: spec.phase,
            source: "contract",
            class: "required_deliverable_missing",
            code: "RECON.md",
            detail: "Required deliverable 'RECON.md' is missing.",
          },
        }),
      }),
    )
    expect(contractFailure.outcome).toBe("failed")
    expect(contractFailure.failure?.source).toBe("contract")

    const interrupted = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => ({
          ...completedPhase(spec.phase),
          ok: false,
          handoff: undefined,
          exitCode: 1,
          termination: "shutdown",
        }),
      }),
    )
    expect(interrupted.outcome).toBe("blocked")
    expect(interrupted.failure).toBeUndefined()
  })

  test("reports a redacted provider diagnostic when a failed phase returned no summary", async () => {
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("brief"), {
        runPhase: async (spec) => ({
          ...completedPhase(spec.phase),
          ok: false,
          summary: "",
          exitCode: 1,
          termination: "subsystem_failed",
          warnings: ["security_policy_block"],
          subsystemFailure: {
            kind: "security_policy_block",
            providerCode: "cyberPolicy",
            detail: "The provider blocked the request.",
            retryable: false,
          },
        }),
      }),
    )

    expect(out.haltedAt).toBe("brief")
    expect(out.summary).toContain("security_policy_block")
    expect(out.summary).toContain("The provider blocked the request.")
    expect(out.summary).not.toContain("produced no textual summary")
  })

  test("interrupting Recon aborts the exact signal passed to its one phase execution", async () => {
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
    expect(out.outcome).toBe("warning")
  })

  test("a validated budget cutoff advances to the successor and keeps the workflow degraded", async () => {
    const phases: string[] = []
    const out = await Effect.runPromise(
      SubsystemOrchestrator.runAndAdvance(baseInput("recon"), {
        runPhase: async (spec) => {
          phases.push(spec.phase)
          return spec.phase === "recon"
            ? {
                ...completedPhase(spec.phase),
                exitCode: 1,
                timedOut: true,
                termination: "budget_exhausted",
                warnings: ["advanced with a sealed partial deliverable"],
              }
            : completedPhase(spec.phase)
        },
      }),
    )

    expect(phases).toEqual(["recon", "exploit", "hacker", "verify", "report"])
    expect(out.terminal).toBe(true)
    expect(out.outcome).toBe("warning")
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
                title: "Pentest completed",
                summaryMarkdown: "The report is ready.",
                artifacts: [{ label: "Report", path: "reports/security-report.pdf" }],
              },
            },
          }
        },
      }),
    )
    expect(out.completion).toEqual({
      title: "Pentest completed",
      summaryMarkdown: "The report is ready.",
      artifacts: [{ label: "Report", path: "reports/security-report.pdf" }],
    })
  })
})
