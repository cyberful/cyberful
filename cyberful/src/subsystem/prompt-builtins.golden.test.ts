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
    personaID: "pentest/recon",
    successor: "exploit",
  },
  {
    id: "bug-bounty/exploit",
    workflow: "bug-bounty",
    phase: "exploit",
    personaID: "pentest/exploit",
    successor: "hacker",
  },
  {
    id: "bug-bounty/hacker",
    workflow: "bug-bounty",
    phase: "hacker",
    personaID: "pentest/hacker",
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
  "pentest/brief": "28eef00a49a14ab87733a6c366eb0435b44b79df5aece1734ccce9f128cfcae5",
  "pentest/recon": "9ddac4b8b2fa1a7c52e762638ea15a3cfd807cc3feaf2a19a0559414a8ecc3a8",
  "pentest/exploit": "c12be0c795918e6f577d2667c0dcd5cfbd68327584259b3b7281a69dcda0b6a5",
  "pentest/hacker": "b6238d71a83925ba1247d809c65eedd6ea268078bdfdad42572d1fe7f8b7b4f8",
  "pentest/verify": "531d8395c35546ffe6d61d30ead842df90fb68b050f0feefbe30038d29b0cbfa",
  "pentest/report": "c5df314ac3525d6ec41a6b5bbd154ed65563eec906dcd5102bfb27e06e5835c9",
  "bug-bounty/brief": "2f255f61798c2fd4c86295fb1d6358a374ece98228bec7221d816ca7712e9dd9",
  "bug-bounty/recon": "8f4122acec885ca0bf6dadcad80167508274519b58e6f130232a27da7fbd7b83",
  "bug-bounty/exploit": "f5f08559eb190fc7e042576383f3208552432869a9f8f1e4a4865eddd982fca6",
  "bug-bounty/hacker": "14eea8f0cf4ca65cf9798bd3b44f0134684a3bc184f59d0be4efeabbfc676013",
  "bug-bounty/verify": "a6763022d19ed7cf6149d6c27df34aeda05c3850b8b9856a6034a80ea7a275b5",
  "bug-bounty/report": "00b6cbfbcaee9acefb862e0a16e4cb08e25e689e449dd74c40e5a48e33077174",
  "code-audit/scope": "f744d41eca1d954b5d5cff66a93565f4f1d675869eb90412df58d2832850bcb4",
  "code-audit/index": "dd0ecb699b13efb023c2a2460ce1f401d129c047a8816e110cd0020b43ab1d40",
  "code-audit/trace": "392907aec15e4f95ff2b4ac0e3c88f66dab833b0f1eef8c1649876554695d212",
  "code-audit/hunt": "c479dc91e96865cea49238304eabb78a70baf2534146158d713105191e5309f1",
  "code-audit/attack": "d8e57a7d7afa8c05884040b09ab437010d2976850f0da28260794cca1319d0d7",
  "code-audit/verify": "eaefbc1deded2836e982639b42204ccda4c1972367610a845dec53107e6c0ed5",
  "code-audit/report": "b8bc14967b9947d76e5d3347f2162f8f98c34334e6dda8dfc18f08507086e761",
  "ask/ask": "5edfd70238ca7614391454490031012846d5b59163907276ce3a990ce5f92d52",
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
  tool: {
    name: "skill_read",
    label: "Read trusted skill",
    description: "Read one explicitly catalogued golden-test skill.",
    parameters: SKILL_READ_PARAMETERS,
    execute: async () => {
      throw new Error("the golden prompt test does not execute skills")
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
    expect(bugBounty.manifest.personaID).toBe(`pentest/${phase}`)
    expect(bugBounty.manifest.componentHashes.persona).toBe(pentest.manifest.componentHashes.persona)
    expect(bugBounty.manifest.componentHashes.authorization).not.toBe(pentest.manifest.componentHashes.authorization)
  }

  expect(actualHashes).toEqual(EXPECTED_SYSTEM_SHA256)
})
