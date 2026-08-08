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
  "pentest/brief": "9a694553a3d94a50db84b2c237224adb26476bd6b7499e71a786244f9ebdf3a2",
  "pentest/recon": "4b7a9dccd210e6cb1060d3849ccf6cfd8c2d0e81309772279700b531fdc87ddd",
  "pentest/exploit": "759514f0efa27e42dd91a819ecee3f6d68d1446ca2afb4cf10d114c651ee0095",
  "pentest/hacker": "445ef31ac576da9eca1274595d68f54a0ef763a189f3a38e332255bbbb426ee5",
  "pentest/verify": "0f9a73f79729e5231bd46e93c600899392053ed67e746a78af0946e8cd2ba021",
  "pentest/report": "70bbfba7876fad99366b57db556767960a9241c5540e126a6312e2e225052680",
  "bug-bounty/brief": "d4676e7f04e2a14e7482e1df71b3e84c327de93d053c232184fa1f28786cb024",
  "bug-bounty/recon": "bff0812a8ff0b1c430b0e302d7cdabadd4f2cda35bcd2832e1c65ac992848980",
  "bug-bounty/exploit": "c0c2f1f4b7edea0dfb4345f7bb535d95798db489b64852e9d20c80d3fd935e11",
  "bug-bounty/hacker": "e08309bcccb4e912026d5a195bb1b36e42a29259e578495fa4af031e0374dd54",
  "bug-bounty/verify": "8b064b4fe1f1ca8fe9ada1ad01c97d27be460fabb854a5bd6ffd9557526ac1ee",
  "bug-bounty/report": "13a9fabe046b15b26ee9efbe57ed4a375d418999f007b0eaa0a287aa9930d4d2",
  "code-audit/scope": "fbb3b06ff866a3c7e0130e09492f07a48d0a2f971fed0ceb26c4552c2c1b2c3b",
  "code-audit/index": "311a4fa396ec8a0d0847d23b5b9c92ffea728bfc79268d109321c68ef33470bb",
  "code-audit/trace": "47b342d1f331d21415464de9426d78cf280b00d5d54498f41904e7697030c601",
  "code-audit/hunt": "6c7bd7d2168f3d39f555a9a0f0e5e008fb1278dad18374572b40e3d362657cb1",
  "code-audit/attack": "ecf522da9bb067c3b6bbcf4d46c1814efc8a0ae68d06cc3c3545cb29058a7cd8",
  "code-audit/verify": "712822931cbe1bbd07fdc85b3db2884907384d19b4348598de278ff74b86e146",
  "code-audit/report": "02a5f23aef65bb0da626e4afc7709b08a17d1f35f5a383cfe4d528837d31357d",
  "ask/ask": "372c3740284a00c1a91aae28e1e9ac3776b30a5193a98ee8f26a9716457c02ac",
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
