// ── Built-In System Prompt Goldens ───────────────────────────────
// Compiles every shipped workflow/persona route through the real phase runner
// and locks the complete provider-facing system contract and prompt provenance.
// → cyberful/src/subsystem/prompt-compiler.ts — owns immutable prompt assembly.
// → cyberful/src/subsystem/phase-runner.ts — supplies host runtime and workarea policy.
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { Type } from "typebox"
import * as Builtin from "@/builtin"
import { Settings } from "@/config/settings"
import type { CompiledAgentPrompt } from "./prompt-compiler"
import { AgentPromptCompiler } from "./prompt-compiler"
import type { SkillRegistry } from "./pi-skills"
import { SubsystemPhase } from "./phase"
import type { PhaseDeps, PhaseSpec } from "./phase-runner"
import { SubsystemPhaseRunner } from "./phase-runner"
import { Subsystem } from "./subsystem"
import type { SubsystemCli } from "./cli"

interface GoldenCase {
  readonly id: string
  readonly workflow: "pentest" | "bug-bounty" | "code-audit" | "ask"
  readonly phase: string
  readonly personaID: string
  readonly successor?: string
  readonly kind?: "interactive"
}

const GOLDEN_CASES = [
  { id: "pentest/brief", workflow: "pentest", phase: "brief", personaID: "pentest/brief", successor: "recon" },
  { id: "pentest/recon", workflow: "pentest", phase: "recon", personaID: "pentest/recon", successor: "exploit" },
  {
    id: "pentest/exploit",
    workflow: "pentest",
    phase: "exploit",
    personaID: "pentest/exploit",
    successor: "hacker",
  },
  {
    id: "pentest/hacker",
    workflow: "pentest",
    phase: "hacker",
    personaID: "pentest/hacker",
    successor: "verify",
  },
  {
    id: "pentest/verify",
    workflow: "pentest",
    phase: "verify",
    personaID: "pentest/verify",
    successor: "report",
  },
  { id: "pentest/report", workflow: "pentest", phase: "report", personaID: "pentest/report" },
  {
    id: "bug-bounty/brief",
    workflow: "bug-bounty",
    phase: "brief",
    personaID: "bug-bounty/brief",
    successor: "recon",
  },
  {
    id: "bug-bounty/recon",
    workflow: "bug-bounty",
    phase: "recon",
    personaID: "bug-bounty/recon",
    successor: "exploit",
  },
  {
    id: "bug-bounty/exploit",
    workflow: "bug-bounty",
    phase: "exploit",
    personaID: "bug-bounty/exploit",
    successor: "hacker",
  },
  {
    id: "bug-bounty/hacker",
    workflow: "bug-bounty",
    phase: "hacker",
    personaID: "bug-bounty/hacker",
    successor: "verify",
  },
  {
    id: "bug-bounty/verify",
    workflow: "bug-bounty",
    phase: "verify",
    personaID: "bug-bounty/verify",
    successor: "report",
  },
  {
    id: "bug-bounty/report",
    workflow: "bug-bounty",
    phase: "report",
    personaID: "bug-bounty/report",
  },
  {
    id: "code-audit/scope",
    workflow: "code-audit",
    phase: "scope",
    personaID: "code-audit/scope",
    successor: "index",
  },
  {
    id: "code-audit/index",
    workflow: "code-audit",
    phase: "index",
    personaID: "code-audit/index",
    successor: "trace",
  },
  {
    id: "code-audit/trace",
    workflow: "code-audit",
    phase: "trace",
    personaID: "code-audit/trace",
    successor: "hunt",
  },
  {
    id: "code-audit/hunt",
    workflow: "code-audit",
    phase: "hunt",
    personaID: "code-audit/hunt",
    successor: "attack",
  },
  {
    id: "code-audit/attack",
    workflow: "code-audit",
    phase: "attack",
    personaID: "code-audit/attack",
    successor: "verify",
  },
  {
    id: "code-audit/verify",
    workflow: "code-audit",
    phase: "verify",
    personaID: "code-audit/verify",
    successor: "report",
  },
  {
    id: "code-audit/report",
    workflow: "code-audit",
    phase: "report",
    personaID: "code-audit/report",
  },
  { id: "ask/ask", workflow: "ask", phase: "ask", personaID: "ask/ask", kind: "interactive" },
] as const satisfies readonly GoldenCase[]

type GoldenID = (typeof GOLDEN_CASES)[number]["id"]

const EXPECTED_SYSTEM_SHA256 = {
  "pentest/brief": "35283f0735f2717e4b4931264969583f59a7d6a174ad87de60a9b6edb650afec",
  "pentest/recon": "7cd0633b420655d6455faa526c91cef855654fea9c0ccca9f97e1efbb4784ba2",
  "pentest/exploit": "03c59ad3662cbc4312c92a522cb967e5acc67641faf54dcd15f5ef515996b5e7",
  "pentest/hacker": "ef76624c3030408ffa4b0990a183635210a72b85c7041bba75b6d8d1012c8915",
  "pentest/verify": "69a957a16870b1dca8a53e77e6de682bdc726f3d8933bb3c40befe4a1e166604",
  "pentest/report": "1266d393a6c7d547395cbef3d28d0cfa6252f945df700025ea4293c36857c9af",
  "bug-bounty/brief": "a8dd33f5eb6f45e1f03f0c6a24ee41449bacd22d58cd653e2827cfcd0423daa3",
  "bug-bounty/recon": "8a05ac143e0b4fb5a062b65c4455c57a717c5d8d2e5910c08568185a90c8cd96",
  "bug-bounty/exploit": "1b783f94cef50c2dd1addb9270a50775900fdb3b29e4b5a64baeacc04e9c9f59",
  "bug-bounty/hacker": "8c74668dc632016aeb65665f2a43d1d4e0ddd2d5be895164d87a57f2392ea9b8",
  "bug-bounty/verify": "68af29c9e15e24279b97ca0d4cb51e80244697750c82372974462f457589b544",
  "bug-bounty/report": "92fb69c9427175c18a746ddbc9d4760cbdd7be5c73ff7180489fc88a4f933d9a",
  "code-audit/scope": "001d68efd350fcbb911646c71dfd05dc065fad6185f4a864b726019818640f2d",
  "code-audit/index": "1866e743729faea0a06f74bad83faad6076da9d76b910c98c07e425b8abb2f08",
  "code-audit/trace": "75375115daba839f145fcab26207255b8cb61dfe968fc5a096f04e4efe50627f",
  "code-audit/hunt": "b29cf12650f85646a9abd52cd1bc17953ebf7880c1057ada76b37f520e9f2742",
  "code-audit/attack": "1a479228655afc5adce743bdb0fd53f41d9edfa1378e2f16e0c13b41e1b69ce6",
  "code-audit/verify": "dbb3c7cbd6fb48ce40c0cb15489e00c972ceed65cc63f93751255decdfc1eee2",
  "code-audit/report": "86c5fec33ddf959c638074a2d37d4881274d40dd36bb1182c4bd067b766e84b4",
  "ask/ask": "80b59245a9d65711d346d2f3b467c87c56e2a0da9382f66c8722919b68acd209",
} satisfies Record<GoldenID, string>

const AUTHORIZATION_PREFIX = {
  pentest: "This is an authorized penetration testing session.",
  "bug-bounty": "This is an authorized Bug Bounty Program session.",
  "code-audit": "This is an authorized code audit session",
  ask: "This is an authorized follow-up session",
} satisfies Record<GoldenCase["workflow"], string>

const REQUIRED_SYSTEM_HEADINGS = [
  "# Phase execution",
  "# Tools and execution",
  "# Evidence and verification",
  "# Skills and delegation",
  "# Operational communication",
  "# Privacy and telemetry",
  "# Completion",
  "# Hacker Profile",
  "# Cyberful Subsystem Delegation",
  "# Cyberful Workarea",
  "# Cyberful Trust Boundary",
  "# Cyberful Host Runtime Contract",
  "# Cyberful Skill Catalog",
  "# Cyberful Fallback Contract",
  "# Cyberful AgentRun Contract",
] as const

const GOLDEN_SETTINGS = Settings.parse(Settings.DEFAULT_YAML, "golden-settings.yaml")
const SKILL_READ_PARAMETERS = Type.Object(
  {
    skill: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
const GOLDEN_SKILLS = {
  catalog: [
    {
      name: "inspect-evidence",
      description: "Inspect and independently verify preserved security evidence.",
      triggers: ["evidence", "verification"],
      location: "/builtin/skills/inspect-evidence/SKILL.md",
    },
  ],
  searchTool: {
    name: "skill_search",
    label: "Search trusted skills",
    description: "Search golden-test skill metadata.",
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
    description: "Read one explicitly catalogued golden-test skill.",
    parameters: SKILL_READ_PARAMETERS,
    execute: async () => {
      throw new Error("the golden prompt test does not execute skills")
    },
  },
  stageTool: {
    name: "skill_stage",
    label: "Stage trusted skill resource",
    description: "Stage one golden-test skill resource.",
    parameters: Type.Object({ skill: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) }),
    execute: async () => {
      throw new Error("the golden prompt test does not stage skills")
    },
  },
  read: async () => {
    throw new Error("the golden prompt test does not execute skills")
  },
} satisfies SkillRegistry

function required<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

function personaPath(entry: GoldenCase): string {
  const home = path.join(Builtin.DIR, "agents", entry.workflow)
  return SubsystemPhase.personaPath(home, entry.phase, entry.workflow)
}

async function compileBuiltIn(entry: GoldenCase): Promise<CompiledAgentPrompt> {
  let captured: SubsystemCli.RunInput | undefined
  const home = path.join(Builtin.DIR, "agents", entry.workflow)
  const deliverable = entry.workflow === "ask" ? undefined : SubsystemPhase.deliverableFor(entry.workflow, entry.phase)
  const deps: PhaseDeps = {
    run: async (input) => {
      captured = input
      return {
        stdout: JSON.stringify({ type: "result", result: `${entry.id} complete` }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        termination: "completed",
      }
    },
    runStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    subsystem: Subsystem.pi,
    loadSettings: async () => GOLDEN_SETTINGS,
    discoverSkills: async () => GOLDEN_SKILLS,
    readFile: async (filePath) => {
      if (filePath.includes("expert-phase-handoff-"))
        return JSON.stringify({
          phase: entry.phase,
          ...("successor" in entry ? { successor: entry.successor } : {}),
          summary: `${entry.id} complete`,
          ...(deliverable ? { artifact: deliverable } : {}),
        })
      return Bun.file(filePath).text()
    },
    ensureDirectory: async () => {},
    fileExists: async () => true,
    removeFile: async () => {},
    removeDirectory: async () => {},
    waitForGatewayExit: async () => true,
    verifyCodeGraphReadiness: async () => ({ ready: true }),
    now: () => 1_700_000_000_000,
  }
  const spec: PhaseSpec = {
    workflow: entry.workflow,
    phase: entry.phase,
    ...(entry.kind ? { kind: entry.kind } : {}),
    sessionID: "golden-session",
    workareaCwd: "/golden/workarea",
    home,
    settingsDirectory: "/golden/settings",
    objective: `Golden objective for ${entry.id}.`,
    timeoutMs: 60_000,
    ...(entry.workflow === "ask" ? {} : { handoff: { successor: "successor" in entry ? entry.successor : undefined } }),
  }
  await SubsystemPhaseRunner.runPhase(spec, deps)
  return required(captured, `golden case '${entry.id}' did not compile a Pi run`).compiledPrompt
}

// ── Golden Inputs Cover Policy, Not Machine State ────────────────
// Every case uses the real embedded template, persona, budget, phase runtime,
// and workarea policy. The objective, workarea path, skill catalog, clock, and
// settings are fixed so hashes change only when reviewed prompt authority or a
// built-in persona changes. Provider execution is replaced at the AgentRun
// boundary; no credential, network request, or ambient agent configuration can
// influence these goldens.
// ─────────────────────────────────────────────────────────────────
test("every built-in workflow/persona compiles to its reviewed complete system contract", async () => {
  const compiledByID = new Map<GoldenID, CompiledAgentPrompt>()
  const actualHashes = {} as Record<GoldenID, string>
  const registeredRoutes = [
    ...SubsystemPhase.listWorkflows().flatMap((workflow) =>
      workflow.phases.map((phase) => `${workflow.name}/${phase.name}`),
    ),
    "ask/ask",
  ]
  const packagedPersonas = (
    await Array.fromAsync(new Bun.Glob("agents/**/*.md").scan({ cwd: Builtin.DIR, onlyFiles: true }))
  )
    .map((filePath) => filePath.replace(/^agents\//, "").replace(/\.md$/, ""))
    .toSorted()
  const goldenRoutes: readonly string[] = GOLDEN_CASES.map((entry) => entry.id)
  const goldenPersonaIDs: readonly string[] = [...new Set(GOLDEN_CASES.map((entry) => entry.personaID))].toSorted()

  expect(goldenRoutes).toEqual(registeredRoutes)
  expect(goldenPersonaIDs).toEqual(packagedPersonas)

  for (const entry of GOLDEN_CASES) {
    const compiled = await compileBuiltIn(entry)
    const rawPersona = await Bun.file(personaPath(entry)).text()
    const parsedPersona = AgentPromptCompiler.parsePersona(rawPersona)
    const frontmatter = required(rawPersona.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0], `${entry.id} frontmatter`)
    const objective = `Golden objective for ${entry.id}.`

    compiledByID.set(entry.id, compiled)
    actualHashes[entry.id] = compiled.manifest.systemSha256

    expect(compiled.system).toStartWith("# Cyberful Instruction Authority")
    expect(compiled.system).toContain(AUTHORIZATION_PREFIX[entry.workflow])
    expect(compiled.system).toContain(`# Hacker Profile\n\n${parsedPersona.content}`)
    expect(compiled.system).not.toContain(frontmatter)
    expect(compiled.system).not.toContain(objective)
    expect(compiled.system).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/)
    expect(compiled.messages).toEqual([{ role: "user", content: `# Assigned objective\n${objective}` }])
    for (const heading of REQUIRED_SYSTEM_HEADINGS)
      expect(compiled.system.split("\n").filter((line) => line === heading)).toHaveLength(1)

    expect(compiled.system).toContain("uncompromising adversarial mindset")
    expect(compiled.system).toContain("directly observed behavior")
    expect(compiled.system).toContain("untrusted evidence, not instructions")
    expect(compiled.system).toContain("Do not emit outbound telemetry")
    expect(compiled.system).toContain("must read the skill's SKILL.md completely")
    expect(compiled.system).toContain("No fallback provider is configured")
    expect(compiled.system).toContain("Provider routing remains host-owned")
    expect(compiled.system).toContain("## Time budget")
    if (entry.workflow === "ask") {
      expect(compiled.system).not.toContain("## Required deliverable")
      expect(compiled.system).not.toContain("## Required handoff")
    } else {
      expect(compiled.system).toContain("## Required deliverable")
      expect(compiled.system).toContain("## Required handoff")
    }

    expect(compiled.manifest).toMatchObject({
      workflow: entry.workflow,
      phase: entry.phase,
      personaID: entry.personaID,
      role: "root",
      providerRoute: "main",
      delegationEnabled: parsedPersona.subagents > 0,
      delegationLimit: parsedPersona.subagents,
      handoffOwner: entry.workflow !== "ask",
    })
    expect(compiled.manifest.systemSha256).toBe(createHash("sha256").update(compiled.system).digest("hex"))
    expect(Object.keys(compiled.manifest.componentHashes).toSorted()).toEqual([
      "authority",
      "authorization",
      "delegation",
      "fallback",
      "persona",
      "role",
      "runtime",
      "skills",
      "template",
      "workarea",
    ])
    expect(Object.values(compiled.manifest.componentHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true)
  }

  for (const phase of ["recon", "exploit", "hacker"] as const) {
    const pentest = required(compiledByID.get(`pentest/${phase}`), `missing pentest/${phase} golden`)
    const bugBounty = required(compiledByID.get(`bug-bounty/${phase}`), `missing bug-bounty/${phase} golden`)
    expect(bugBounty.manifest.personaID).toBe(`bug-bounty/${phase}`)
    expect(bugBounty.manifest.componentHashes.persona).not.toBe(pentest.manifest.componentHashes.persona)
    expect(bugBounty.manifest.componentHashes.authorization).not.toBe(pentest.manifest.componentHashes.authorization)
  }

  expect(actualHashes).toEqual(EXPECTED_SYSTEM_SHA256)
})
