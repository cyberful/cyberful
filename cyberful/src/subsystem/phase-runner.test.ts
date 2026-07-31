// ── Pi Phase Runner Tests ─────────────────────────────────────────
// Verifies phase invocation, handoff validation, artifact manifests, deadlines,
// cancellation, process reaping, and cleanup through observable run outcomes.
// → cyberful/src/subsystem/phase-runner.ts — owns the tested single-phase lifecycle.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Type } from "typebox"
import { mkdir, mkdtemp, readFile as readFileFromDisk, realpath, rm, stat, symlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createHash } from "node:crypto"
import { Settings } from "@/config/settings"
import {
  SubsystemPhaseRunner,
  waitForGatewayExit,
  type GatewayReapDeps,
  type PhaseDeps,
  type PhaseSpec,
} from "./phase-runner"
import { Subsystem } from "./subsystem"
import { isRecord } from "@/util/record"
import type { AgentEvent } from "./agent-subsystem"
import type { SkillRegistry } from "./pi-skills"

// ── Transcript Tests Exercise Headless And Observed Runs ────────────
// A configured transcript must retain the full redacted AgentEvent record even when no
// TUI observer is attached. These cases cross the real phase-runner decision
// boundary with injected runtime and filesystem adapters, proving stream
// selection, destination, contents, and failure reporting without contacting a
// live model or weakening the production orchestration path.
// ──────────────────────────────────────────────────────────────

// A minimal two-line AgentEvent transcript: one assistant turn plus the terminal
// result envelope that a real persisted phase run buffers.
const NDJSON =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n' +
  '{"type":"result","result":"phase summary"}\n'

const TRANSCRIPT = "/tmp/cyberful-logs/session-ses_test.expert-recon.jsonl"
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
  tool: {
    name: "skill_read",
    label: "Read trusted skill",
    description: "No skills are configured in this isolated phase-runner test.",
    parameters: EMPTY_SKILL_PARAMETERS,
    execute: async () => {
      throw new Error("no test skills are configured")
    },
  },
  read: async () => {
    throw new Error("no test skills are configured")
  },
} satisfies SkillRegistry
const BASE_INSTRUCTIONS_TEMPLATE = [
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

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

function spec(over: Partial<PhaseSpec> = {}): PhaseSpec {
  return {
    phase: "recon",
    sessionID: "ses_test",
    workareaCwd: "/tmp/wa",
    home: "/tmp/home",
    objective: "carry out recon",
    timeoutMs: 60_000,
    ...over,
  }
}

function phaseInstructionFile(filePath: string) {
  if (filePath.endsWith("baseInstructions.md")) return BASE_INSTRUCTIONS_TEMPLATE
  if (filePath.endsWith(".md")) return "# Phase persona"
  return undefined
}

const subsystem: Subsystem.Subsystem = {
  ...Subsystem.pi,
  extractResultText: () => "phase summary",
  streamActivities: () => [],
}

// Deps default to a buffered `run` (which SHOULD NOT be taken when persisting) and a streaming run that
// replays NDJSON to onEvent then returns it as stdout — so a test can assert which path executed.
function deps(over: Partial<PhaseDeps> = {}): PhaseDeps {
  return {
    run: async () => ({
      stdout: '{"type":"result","result":"phase summary"}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
    runStreaming: async (input, onEvent) => {
      for (const line of NDJSON.trim().split("\n")) {
        await input.transcript?.append(`${line}\n`)
        onEvent(JSON.parse(line))
      }
      return { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
    },
    subsystem,
    loadSettings: async () => TEST_SETTINGS,
    discoverSkills: async () => EMPTY_SKILLS,
    readFile: async (filePath) => phaseInstructionFile(filePath) ?? "{}",
    ensureDirectory: async () => {},
    fileExists: async () => true,
    ...over,
  }
}

describe("runPhase transcript persistence", () => {
  test("persists the full AgentEvent transcript to spec.transcriptPath", async () => {
    const writes: Array<{ filePath: string; ndjson: string }> = []
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        createTranscript: async (filePath) => {
          let ndjson = ""
          return {
            append: async (line) => {
              ndjson += line
            },
            close: async () => {
              writes.push({ filePath, ndjson })
            },
          }
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.filePath).toBe(TRANSCRIPT)
    expect(writes[0]?.ndjson.startsWith(NDJSON)).toBe(true)
    const write = requireValue(writes[0], "phase runner did not persist the expected transcript")
    const statusLine = requireValue(
      write.ndjson.trim().split("\n").at(-1),
      "persisted transcript did not contain a terminal status line",
    )
    const status: unknown = JSON.parse(statusLine)
    if (!isRecord(status)) throw new Error("persisted terminal status is not an object")
    expect(status.type).toBe("cyberful.phase.status")
    expect(status.termination).toBe("completed")
    expect(status.backend).toBe("pi")
  })

  test("forces stream mode when persisting even with no live observer (runStreaming, not run)", async () => {
    let ranBuffered = false
    let ranStreaming = false
    await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        run: async () => ((ranBuffered = true), { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }),
        runStreaming: async () => ((ranStreaming = true), { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }),
        createTranscript: async () => ({ append: async () => {}, close: async () => {} }),
      }),
    )
    expect(ranStreaming).toBe(true)
    expect(ranBuffered).toBe(false)
  })

  test("the 0600 transcript grows on disk while its phase is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberful-live-transcript-"))
    const transcriptPath = join(root, "logs", "active.jsonl")
    const appended = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const task = SubsystemPhaseRunner.runPhase(
        spec({ transcriptPath }),
        deps({
          createTranscript: requireValue(
            SubsystemPhaseRunner.defaultDeps().createTranscript,
            "default phase dependencies did not expose a transcript writer",
          ),
          runStreaming: async (input) => {
            await input.transcript?.append('{"type":"activity","state":"active"}\n')
            appended.resolve()
            await release.promise
            await input.transcript?.append('{"type":"result","result":"phase summary"}\n')
            return { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
          },
        }),
      )
      await appended.promise
      expect(await readFileFromDisk(transcriptPath, "utf8")).toContain('"state":"active"')
      expect((await stat(transcriptPath)).mode & 0o777).toBe(0o600)
      release.resolve()
      expect((await task).ok).toBe(true)
      expect(await readFileFromDisk(transcriptPath, "utf8")).toContain('"cyberful.phase.status"')
    } finally {
      release.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("persists subsystem usage and derived context churn without inferring prompt text", async () => {
    const usageProvider: Subsystem.Subsystem = {
      ...subsystem,
      streamActivities: Subsystem.pi.streamActivities,
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        subsystem: usageProvider,
        onActivity: () => {},
        runStreaming: async (_input, onEvent) => {
          onEvent({
            type: "activity",
            runID: "root",
            activity: {
              kind: "progress",
              usage: {
                generatedTokens: 100,
                inputTokens: 400,
                reasoningTokens: 30,
                cacheReadTokens: 250,
                cacheWriteTokens: 20,
              },
            },
          })
          return { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(result.usage).toEqual({
      input: 400,
      output: 100,
      reasoning: 30,
      cache: { read: 250, write: 20 },
    })
    expect(result.contextChurn).toEqual({
      uncachedInput: 420,
      cacheReadRatio: 0.3731,
      inputAmplification: 6.7,
      churnRatio: 0.6269,
      reasoningShare: 0.3,
    })
  })

  test("without a transcriptPath, an unobserved phase stays on the buffered json path and writes nothing", async () => {
    let ranBuffered = false
    let ranStreaming = false
    let wrote = false
    await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: undefined }),
      deps({
        run: async () => ((ranBuffered = true), { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }),
        runStreaming: async () => ((ranStreaming = true), { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }),
        createTranscript: async () => {
          wrote = true
          return { append: async () => {}, close: async () => {} }
        },
      }),
    )
    expect(ranBuffered).toBe(true)
    expect(ranStreaming).toBe(false)
    expect(wrote).toBe(false)
  })

  test("the phase prompt routes blocking human decisions through the TUI question tool", async () => {
    let system = ""
    let userMessage = ""
    let skillRoots: readonly string[] | undefined
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async (input) => {
          system = input.compiledPrompt.system
          userMessage = input.compiledPrompt.messages[0]?.content ?? ""
          skillRoots = input.spec.skillRoots
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(system).toMatch(/question.*concrete missing authorization, fact, or human CAPTCHA action/i)
    expect(system).toContain("`question kind=captcha`")
    expect(system).toMatch(/Other work continues/i)
    expect(system).toContain("Do not retry a target request that returns HTTP `429`")
    expect(system).not.toMatch(/403|WAF|managed challenge|reset/i)
    expect(userMessage).toContain("carry out recon")
    expect(userMessage).not.toContain("Cyberful Host Runtime Contract")
    expect(skillRoots).toEqual(["/tmp/skills"])
  })

  test("resolves the Bug Bounty novelty reserve into both prompt and private gateway contract", async () => {
    let system = ""
    let privateEnv: Readonly<Record<string, string>> | undefined
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ workflow: "bug-bounty", phase: "recon" }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json"))
            return JSON.stringify({
              recon: 60,
              $novelty: { recon: { required: true } },
            })
          return phaseInstructionFile(filePath) ?? "{}"
        },
        run: async (input) => {
          system = input.compiledPrompt.system
          privateEnv = input.spec.mcpServer?.privateEnv
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(system).toContain("## Contrarian pass")
    expect(system).toMatch(/no numeric quotas/i)
    expect(JSON.parse(requireValue(privateEnv, "gateway private env missing").CYBERFUL_SUBSYSTEM_NOVELTY_CONTRACT ?? "null"))
      .toEqual(result.noveltyContract)
  })

  test("human approval wait extends the deadline without consuming phase duration", async () => {
    const before = Date.now()
    const result = await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        askQuestion: async () => {
          await Bun.sleep(35)
          return [["Approve"]]
        },
        run: async (input) => {
          const ask = requireValue(input.askQuestion, "phase did not expose its human question callback")
          await ask(
            [
              {
                header: "Mutation",
                question: "Allow the bounded mutation?",
                options: [{ label: "Approve", description: "Continue." }],
              },
            ],
            new AbortController().signal,
          )
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    const wallMs = Date.now() - before

    expect(result.approvalWaitMs).toBeGreaterThanOrEqual(25)
    expect(result.durationMs).toBeLessThan(wallMs)
    expect(result.deadlineAt).toBeGreaterThanOrEqual(before + result.limitMs + (result.approvalWaitMs ?? 0) - 10)
  })

  test("a recovery owner receives only the active phase budget that remains", async () => {
    let runtimeTimeoutMs = 0
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        attempt: 2,
        timeoutMs: 30_000,
        budgetCarry: {
          approvalWaitMs: 2_000,
          retryWaitMs: 12_000,
          phaseExtensionMs: 10_000,
        },
      }),
      deps({
        readFile: async (filePath) =>
          filePath.endsWith("budgets.json")
            ? JSON.stringify({ recon: 60 })
            : phaseInstructionFile(filePath) ?? "{}",
        run: async (input) => {
          runtimeTimeoutMs = input.timeoutMs
          expect(input.budgetClock?.snapshot()).toMatchObject({
            approvalWaitMs: 2_000,
            retryWaitMs: 12_000,
            retryCompensationMs: 10_000,
          })
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(result.limitMs).toBe(60 * 60_000)
    expect(result.effectiveLimitMs).toBeLessThanOrEqual(30_000)
    expect(runtimeTimeoutMs).toBeLessThanOrEqual(30_000)
    expect(result.retryCompensationCapMs).toBe(15 * 60_000)
    expect(result.retryCompensationMs).toBe(10_000)
  })

  test("the phase prompt maps account descriptions to isolated browser profile selectors", async () => {
    let system = ""
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async (input) => {
          system = input.compiledPrompt.system
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(system).toMatch(/Browser profiles 1–5 are separate identities/i)
    expect(system).toMatch(/keep their state and evidence separate/i)
  })

  test("routes imported-source execution through cyberful-os without hardcoding a host path", async () => {
    let baseInstructions = ""
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async (input) => {
          baseInstructions = input.spec.baseInstructions ?? ""
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(baseInstructions).toContain("workarea root is intentionally an artifact workspace")
    expect(baseInstructions).toContain("`git status`, `git diff`, or `git rev-parse`")
    expect(baseInstructions).toContain("explicitly materializes a nested repository or disposable lab")
    expect(baseInstructions).toContain("host's native shell only for static-analysis operations")
    expect(baseInstructions).toContain("host shell remains available for all other purposes")
    expect(baseInstructions).toContain("cyberful-os `shell` MCP tool")
    expect(baseInstructions).toContain("`relative/path` to `/workspace/relative/path`")
    expect(baseInstructions).toContain("Network access remains available inside cyberful-os")
    expect(baseInstructions).toContain("# Cyberful Workarea")
    expect(baseInstructions).not.toContain("</CYBERFUL WORKAREA>")
  })

  test("keeps worker scratch state in the workarea and gateway secrets out of the Pi system message", async () => {
    let privateEnv: Record<string, string> | undefined
    let system = ""
    const directories: string[] = []
    const removed: string[] = []
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        ensureDirectory: async (directory) => {
          directories.push(directory)
        },
        removeDirectory: async (directory) => {
          removed.push(directory)
        },
        run: async (input) => {
          system = input.compiledPrompt.system
          privateEnv = input.spec.mcpServer?.privateEnv
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(directories).toEqual(["/tmp/wa/.cyberful-tmp"])
    expect(removed).toEqual(["/tmp/wa/.cyberful-tmp"])
    expect(privateEnv?.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH).toContain("expert-circuit-breaker-ses_test/engagement.json")
    expect(system).not.toContain(
      requireValue(privateEnv, "gateway private environment missing").CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH,
    )
  })

  test("counts only distinct deliverable checkpoints as semantic progress", async () => {
    let complete = false
    const progress: SubsystemPhaseRunner.SemanticProgress[] = []
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit" }),
      deps({
        run: async () => {
          complete = true
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
        writeArtifactCheckpoint: async (checkpoint, artifact) => {
          expect(checkpoint).toBe("/tmp/wa/raw/phase-checkpoints/exploit/EXPLOIT.md")
          expect(artifact).toBe("/tmp/wa/EXPLOIT.md")
          if (!complete) throw new Error("not written yet")
          return "final-hash"
        },
        onSemanticProgress: (event) => progress.push(event),
      }),
    )
    expect(result.semanticCheckpoints).toBe(1)
    expect(result.lastSemanticProgressAt).toBeDefined()
    expect(progress).toHaveLength(1)
    expect(progress[0]?.sha256).toBe("final-hash")
  })

  test("settles event-triggered checkpoint writes before returning the phase result", async () => {
    let attempts = 0
    let activeWrites = 0
    let maximumConcurrentWrites = 0
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit" }),
      deps({
        onActivity: () => {},
        runStreaming: async (_input, onEvent) => {
          const events: readonly AgentEvent[] = [
            {
              type: "run_started",
              runID: "root",
              phaseRootID: "root",
              role: "root",
              provider: "main-test",
              model: "gpt-5.4",
              providerAffinity: "main",
              reasoningEffort: "ultra",
              effectiveReasoningEffort: "xhigh",
              context: {
                catalogContextWindow: 272_000,
                trustedRouteWindow: 272_000,
                operationalContextWindow: 256_000,
                continuationReserveTokens: 16_384,
                hardInputTokens: 255_616,
                effectiveOperationalWindow: 256_000,
                source: "catalog_default",
                warnings: [],
              },
              promptSystemSha256: "sha256",
              promptManifest: {
                workflow: "pentest",
                phase: "exploit",
                personaID: "pentest/exploit",
                role: "root",
                providerRoute: "main",
                systemSha256: "sha256",
                componentHashes: {},
                delegationEnabled: true,
                delegationLimit: 1,
                handoffOwner: true,
              },
            },
            {
              type: "run_finished",
              runID: "root",
              termination: "completed",
              usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
              skillsUsed: [],
              childRunIDs: [],
              fallbackAdmissions: 0,
              fallbackDescendants: 0,
              toolCalls: 0,
            },
          ]
          for (const event of events) onEvent(event)
          return { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
        },
        writeArtifactCheckpoint: async () => {
          attempts += 1
          activeWrites += 1
          maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites)
          await Promise.resolve()
          activeWrites -= 1
          if (attempts === 1) throw new Error("deliverable not written yet")
          return attempts === 2 ? "first-hash" : "final-hash"
        },
      }),
    )

    expect(attempts).toBe(4)
    expect(maximumConcurrentWrites).toBe(1)
    expect(result.semanticCheckpoints).toBe(2)
    expect(result.warnings).not.toContain("deliverable not written yet")
  })

  test("requires and returns the constrained handoff after the Pi owner shuts down", async () => {
    let processExited = false
    let handoffReadBeforeExit = false
    let gatewayWaitBeforeExit = false
    let privateEnv: Readonly<Record<string, string>> | undefined
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        run: async (input) => {
          privateEnv = input.spec.mcpServer?.privateEnv
          processExited = true
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false, termination: "completed" }
        },
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          handoffReadBeforeExit = !processExited
          return JSON.stringify({
            phase: "exploit",
            successor: "hacker",
            summary: "exploit complete",
            artifact: "EXPLOIT.md",
          })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => {
          gatewayWaitBeforeExit = !processExited
          return true
        },
      }),
    )
    expect(handoffReadBeforeExit).toBe(false)
    expect(gatewayWaitBeforeExit).toBe(false)
    expect(privateEnv?.CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT).toBe("EXPLOIT.md")
    expect(result.ok).toBe(true)
    expect(result.summary).toBe("exploit complete")
    expect(result.handoff).toEqual({
      phase: "exploit",
      successor: "hacker",
      summary: "exploit complete",
      artifact: "EXPLOIT.md",
    })
  })

  test("a gateway lifecycle failure blocks an otherwise valid handoff", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          return JSON.stringify({
            phase: "exploit",
            successor: "hacker",
            summary: "exploit complete",
            artifact: "EXPLOIT.md",
          })
        },
        removeFile: async () => {},
        waitForGatewayExit: async (_path, _timeout, registrationRequired) => {
          expect(registrationRequired).toBe(true)
          return false
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.phaseFailure).toMatchObject({
      source: "lifecycle",
      class: "gateway_exit_unverified",
    })
    expect(result.warnings.join("\n")).not.toContain("gateway")
  })

  test("blocks Code Audit index to trace when host graph readiness is invalid", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        workflow: "code-audit",
        phase: "index",
        sourceRoot: "/tmp/source",
        handoff: { successor: "trace" },
      }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ index: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          return JSON.stringify({
            phase: "index",
            successor: "trace",
            summary: "index complete",
            artifact: "CODE_GRAPH.md",
          })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
        verifyCodeGraphReadiness: async () => {
          throw new Error("coverage attestation is missing")
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "successor_readiness_failed",
      detail: "Code Audit index readiness failed; trace is blocked: coverage attestation is missing",
    })
  })

  test("accepts Code Audit index to trace after host graph readiness succeeds", async () => {
    let verified = false
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        workflow: "code-audit",
        phase: "index",
        sourceRoot: "/tmp/source",
        handoff: { successor: "trace" },
      }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ index: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          return JSON.stringify({ phase: "index", successor: "trace", summary: "index complete" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
        verifyCodeGraphReadiness: async () => {
          verified = true
        },
      }),
    )

    expect(verified).toBe(true)
    expect(result.ok).toBe(true)
  })

  test("a configured phase cannot pass without calling handoff", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          throw new Error("handoff missing")
        },
        removeFile: async () => {},
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "handoff_invalid",
      detail: "Required handoff was not completed: handoff missing",
    })
  })

  test("a missing handoff does not expose its ephemeral host signal path", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: "ENOENT" })
        },
        removeFile: async () => {},
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "handoff_invalid",
      detail: "Required handoff was not completed: no handoff was recorded.",
    })
    expect(result.warnings.join("\n")).not.toContain("expert-phase-handoff-")
  })

  test("a phase budget cutoff advances with a sealed partial deliverable", async () => {
    const manifests: string[] = []
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        run: async () => ({
          stdout: "{}",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          termination: "budget_exhausted",
        }),
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 15 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          throw Object.assign(new Error("handoff signal does not exist"), { code: "ENOENT" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
        writeArtifactManifest: async (manifestPath) => {
          manifests.push(manifestPath)
        },
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.termination).toBe("budget_exhausted")
    expect(result.handoff).toEqual({
      phase: "exploit",
      successor: "hacker",
      summary:
        "The exploit phase exhausted its active-execution budget. Continue from the sealed partial deliverable 'EXPLOIT.md' and treat unfinished coverage as degraded.\n\nphase summary",
      artifact: "EXPLOIT.md",
    })
    expect(manifests).toEqual(["/tmp/wa/raw/phase-manifests/exploit.sha256"])
    expect(result.warnings).toContain(
      "Phase budget exhausted before an explicit handoff; advancing with sealed partial deliverable 'EXPLOIT.md'.",
    )
    expect(result.warnings.join("\n")).not.toContain("Required handoff was not completed")
  })

  test("a Brief budget cutoff preserves MISSION.md but cannot advance without explicit handoff", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        workflow: "pentest",
        phase: "brief",
        objective: "prepare the engagement mission",
        handoff: { successor: "recon" },
      }),
      deps({
        run: async () => ({
          stdout: "{}",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          termination: "budget_exhausted",
        }),
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ brief: 10 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          throw Object.assign(new Error("handoff signal does not exist"), { code: "ENOENT" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
        writeArtifactManifest: async () => {},
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.handoff).toBeUndefined()
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "handoff_invalid",
    })
    expect(result.warnings.join("\n")).not.toContain("advancing with sealed partial deliverable")
  })

  test("a phase budget cutoff still halts when its required deliverable is missing", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        run: async () => ({
          stdout: "{}",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          termination: "budget_exhausted",
        }),
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 15 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          throw Object.assign(new Error("handoff signal does not exist"), { code: "ENOENT" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
        fileExists: async () => false,
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.handoff).toBeUndefined()
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "required_deliverable_missing",
      detail: "Required deliverable 'EXPLOIT.md' is missing.",
    })
  })

  test("a phase budget cutoff does not repair an invalid handoff", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        run: async () => ({
          stdout: "{}",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          termination: "budget_exhausted",
        }),
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 15 })
          const instruction = phaseInstructionFile(filePath)
          if (instruction) return instruction
          return JSON.stringify({ phase: "exploit", successor: "report", summary: "skip ahead" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.handoff).toBeUndefined()
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "handoff_invalid",
      detail: "Handoff successor does not match the configured chain.",
    })
  })

  test("ignores the removed transcript environment toggle and keeps host-owned audit persistence", async () => {
    process.env.CYBERFUL_SUBSYSTEM_TRANSCRIPT = "0"
    let wrote = false
    let ranBuffered = false
    let ranStreaming = false
    await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        run: async () => ((ranBuffered = true), { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }),
        runStreaming: async () => (
          (ranStreaming = true),
          { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
        ),
        createTranscript: async () => {
          wrote = true
          return { append: async () => {}, close: async () => {} }
        },
      }),
    )
    delete process.env.CYBERFUL_SUBSYSTEM_TRANSCRIPT
    expect(wrote).toBe(true)
    expect(ranStreaming).toBe(true)
    expect(ranBuffered).toBe(false)
  })

  test("a transcript write failure does not fail the phase", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        createTranscript: async () => {
          throw new Error("disk full")
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.warnings).toContain("Could not create the phase transcript: disk full")
  })

  test("a missing deliverable is subsystem_failed but remains a normal PhaseResult", async () => {
    const result = await SubsystemPhaseRunner.runPhase(spec(), deps({ fileExists: async () => false }))
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("subsystem_failed")
    expect(result.phaseFailure).toMatchObject({
      source: "contract",
      class: "required_deliverable_missing",
      detail: "Required deliverable 'RECON.md' is missing.",
    })
    expect(result.warnings.join("\n")).not.toContain("Required deliverable")
  })

  test("writes the authoritative deliverable manifest only after owner shutdown and gateway exit", async () => {
    let processExited = false
    let gatewayExited = false
    const writes: Array<{ manifestPath: string; artifactPath: string }> = []
    const result = await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async () => {
          processExited = true
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false, termination: "completed" }
        },
        waitForGatewayExit: async () => {
          expect(processExited).toBe(true)
          gatewayExited = true
          return true
        },
        writeArtifactManifest: async (manifestPath, artifactPath) => {
          expect(processExited).toBe(true)
          expect(gatewayExited).toBe(true)
          writes.push({ manifestPath, artifactPath })
        },
      }),
    )
    expect(writes).toEqual([
      {
        manifestPath: "/tmp/wa/raw/phase-manifests/recon.sha256",
        artifactPath: "/tmp/wa/RECON.md",
      },
    ])
    expect(result.ok).toBe(true)
    expect(result.artifactManifest).toBe("raw/phase-manifests/recon.sha256")
  })

  test("fails closed when the host cannot seal a completed deliverable", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        writeArtifactManifest: async () => {
          throw new Error("disk full")
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("subsystem_failed")
    expect(result.artifactManifest).toBeUndefined()
    expect(result.phaseFailure).toMatchObject({
      source: "lifecycle",
      class: "artifact_manifest_failed",
      detail: "Could not write the final artifact manifest: disk full",
    })
  })

  test("leaves REPORT.md sealing to the terminal host render", async () => {
    let wrote = false
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "report", workflow: "pentest" }),
      deps({
        writeArtifactManifest: async () => {
          wrote = true
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(wrote).toBe(false)
    expect(result.artifactManifest).toBeUndefined()
  })

  // The other tests stub createTranscript; this one exercises the REAL default writer, so the mkdir -p of
  // the parent directory and the exact appended byte content are verified on disk.
  test("transcript persistence creates its parent and preserves the supplied bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gym-logs-"))
    try {
      // A path two levels deep, so the write only succeeds if the parent chain is created.
      const file = join(root, "session-logs", "session-ses_x.expert-recon.jsonl")
      const createTranscript = requireValue(
        SubsystemPhaseRunner.defaultDeps().createTranscript,
        "default phase dependencies did not expose a transcript writer",
      )
      const transcript = await createTranscript(file)
      await transcript.append(NDJSON)
      await transcript.close()
      expect(await readFileFromDisk(file, "utf8")).toBe(NDJSON)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("default artifact writer hashes the final bytes and names the artifact", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-manifest-")))
    try {
      const artifact = join(root, "HACKER.md")
      const manifest = join(root, "raw", "phase-manifests", "hacker.sha256")
      await Bun.write(artifact, "final artifact\n")
      const writeArtifactManifest = requireValue(
        SubsystemPhaseRunner.defaultDeps().writeArtifactManifest,
        "default phase dependencies did not expose an artifact manifest writer",
      )
      await writeArtifactManifest(manifest, artifact)
      expect(await readFileFromDisk(manifest, "utf8")).toBe(
        `${createHash("sha256").update("final artifact\n").digest("hex")}  HACKER.md\n`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("default checkpoint writer atomically keeps the latest valid deliverable", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-checkpoint-")))
    try {
      const artifact = join(root, "RECON.md")
      const checkpoint = join(root, "raw", "phase-checkpoints", "recon", "RECON.md")
      await Bun.write(artifact, "first\n")
      const first = await SubsystemPhaseRunner.writeArtifactCheckpoint(checkpoint, artifact)
      await Bun.write(artifact, "second\n")
      const second = await SubsystemPhaseRunner.writeArtifactCheckpoint(checkpoint, artifact)
      expect(first).not.toBe(second)
      expect(await readFileFromDisk(checkpoint, "utf8")).toBe("second\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("artifact sealing rejects linked artifacts and linked manifest directories", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-manifest-boundary-")))
    const outside = await realpath(await mkdtemp(join(tmpdir(), "phase-manifest-outside-")))
    try {
      const artifact = join(root, "HACKER.md")
      const manifest = join(root, "raw", "phase-manifests", "hacker.sha256")
      const outsideArtifact = join(outside, "outside.md")
      await Bun.write(outsideArtifact, "outside\n")
      await symlink(outsideArtifact, artifact)
      await expect(SubsystemPhaseRunner.writeArtifactManifest(manifest, artifact)).rejects.toThrow("regular file")

      await rm(artifact)
      await rm(join(root, "raw"), { recursive: true, force: true })
      await Bun.write(artifact, "inside\n")
      await mkdir(join(outside, "phase-manifests"))
      const outsideManifest = join(outside, "phase-manifests", "hacker.sha256")
      await Bun.write(outsideManifest, "must survive\n")
      await symlink(outside, join(root, "raw"), "dir")
      await expect(SubsystemPhaseRunner.writeArtifactManifest(manifest, artifact)).rejects.toThrow("plain directory")
      expect(await readFileFromDisk(outsideManifest, "utf8")).toBe("must survive\n")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("workflow-scopes shared phase artifact paths", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-workflow-scope-")))
    try {
      const codeAudit = SubsystemPhaseRunner.artifactManifestPath({
        workflow: "code-audit",
        phase: "verify",
        workareaCwd: root,
      })
      const pentest = SubsystemPhaseRunner.artifactManifestPath({
        workflow: "pentest",
        phase: "verify",
        workareaCwd: root,
      })
      const bugBounty = SubsystemPhaseRunner.artifactManifestPath({
        workflow: "bug-bounty",
        phase: "verify",
        workareaCwd: root,
      })
      expect(codeAudit).toBe(join(root, "raw", "phase-manifests", "code-audit", "verify.sha256"))
      expect(pentest).toBe(join(root, "raw", "phase-manifests", "pentest", "verify.sha256"))
      expect(bugBounty).toBe(join(root, "raw", "phase-manifests", "bug-bounty", "verify.sha256"))
      expect(codeAudit).not.toBe(pentest)
      expect(bugBounty).not.toBe(pentest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("writes a separate runtime manifest without subsystem secrets or prompts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-runtime-manifest-")))
    try {
      const result = await SubsystemPhaseRunner.runPhase(
        spec({
          workareaCwd: root,
        }),
        deps({
          writeRuntimeManifest: SubsystemPhaseRunner.writeRuntimeManifest,
        }),
      )
      const manifestPath = join(root, "raw", "phase-manifests", "recon.runtime.json")
      const contents = await readFileFromDisk(manifestPath, "utf8")
      const manifest: unknown = JSON.parse(contents)
      expect(result.runtimeManifest).toBe("raw/phase-manifests/recon.runtime.json")
      expect(manifest).toMatchObject({
        version: 6,
        phase: "recon",
        backend: "pi",
        budget: {
          retryWaitMs: 0,
          retryCompensationMs: 0,
          phaseExtensionMs: 0,
          phaseExtensionCapMs: 15 * 60_000,
          retryCompensationCapReached: false,
          closeoutReserveMs: 30_000,
        },
      })
      expect(contents).not.toContain("developerInstructions")
      expect(contents).not.toContain("baseInstructions")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("default temporary-directory setup rejects a linked workarea child", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-temp-boundary-")))
    const outside = await realpath(await mkdtemp(join(tmpdir(), "phase-temp-outside-")))
    try {
      await symlink(outside, join(root, ".cyberful-tmp"), "dir")
      await expect(SubsystemPhaseRunner.defaultDeps().ensureDirectory(join(root, ".cyberful-tmp"))).rejects.toThrow(
        "plain directory",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("interactive Ask excursion", () => {
  test("is autonomous and has no deliverable or handoff contract", async () => {
    let system = ""
    let userMessage = ""
    let permission = ""
    let privateEnv: Record<string, string> | undefined
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "ask", kind: "interactive", home: "/tmp/agents/ask", objective: "Explain the report" }),
      deps({
        run: async (input) => {
          system = input.compiledPrompt.system
          userMessage = input.compiledPrompt.messages[0]?.content ?? ""
          permission = input.spec.permission.kind
          privateEnv = input.spec.mcpServer?.privateEnv
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(permission).toBe("autonomous")
    expect(system).toContain("one autonomous Ask turn")
    expect(userMessage).toContain("Explain the report")
    expect(system).not.toContain("Required deliverable")
    expect(privateEnv?.CYBERFUL_SUBSYSTEM_HANDOFF_PATH).toBeUndefined()
  })

  test("a budget cutoff remains unsuccessful without a phase handoff contract", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "ask", kind: "interactive", home: "/tmp/agents/ask", objective: "Explain the report" }),
      deps({
        run: async () => ({
          stdout: "{}",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          termination: "budget_exhausted",
        }),
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.termination).toBe("budget_exhausted")
    expect(result.handoff).toBeUndefined()
  })
})

describe("phase gateway lifecycle", () => {
  function lifecycleDeps(over: Partial<GatewayReapDeps> = {}): GatewayReapDeps {
    let now = 0
    return {
      readSignal: async () => JSON.stringify({ pid: 77 }),
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      processAlive: () => false,
      processGroupAlive: () => false,
      signalProcess: () => {},
      killTree: () => {},
      ...over,
    }
  }

  test("accepts a gateway that the Pi owner already closed because its startup PID remains provable", async () => {
    const signals: string[] = []
    const result = await waitForGatewayExit(
      "/tmp/gateway-pid.json",
      5_000,
      true,
      lifecycleDeps({
        signalProcess: (_pid, signal) => {
          signals.push(signal)
        },
        killTree: (_pid, signal) => {
          signals.push(`tree:${signal}`)
        },
      }),
    )
    expect(result).toBe(true)
    expect(signals).toEqual([])
  })

  test("asks a live gateway to close gracefully after the Pi owner closes its bridge", async () => {
    let alive = true
    const signals: string[] = []
    const result = await waitForGatewayExit(
      "/tmp/gateway-pid.json",
      5_000,
      true,
      lifecycleDeps({
        processAlive: () => alive,
        signalProcess: (_pid, signal) => {
          signals.push(signal)
          if (signal === "SIGTERM") alive = false
        },
      }),
    )
    expect(result).toBe(true)
    expect(signals).toEqual(["SIGTERM"])
  })

  test("group-kills a gateway tree that ignores the graceful close", async () => {
    let alive = true
    const signals: string[] = []
    const result = await waitForGatewayExit(
      "/tmp/gateway-pid.json",
      200,
      true,
      lifecycleDeps({
        processAlive: () => alive,
        processGroupAlive: () => alive,
        signalProcess: (_pid, signal) => {
          signals.push(signal)
          if (signal === "SIGKILL") alive = false
        },
        killTree: (_pid, signal) => {
          signals.push(`tree:${signal}`)
        },
      }),
    )
    expect(result).toBe(true)
    expect(signals).toEqual(["SIGTERM", "tree:SIGKILL", "SIGKILL"])
  })

  test("requires PID registration for a handoff phase but not for an unused optional gateway", async () => {
    const missing = lifecycleDeps({ readSignal: async () => "{}" })
    expect(await waitForGatewayExit("/tmp/missing.json", 100, true, missing)).toBe(false)
    expect(
      await waitForGatewayExit("/tmp/missing.json", 100, false, lifecycleDeps({ readSignal: async () => "{}" })),
    ).toBe(true)
  })
})
