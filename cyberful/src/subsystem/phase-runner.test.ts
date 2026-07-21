// ── Codex Phase Runner Tests ──────────────────────────────────────
// Verifies phase invocation, handoff validation, artifact manifests, deadlines,
// cancellation, process reaping, and cleanup through observable run outcomes.
// → cyberful/src/subsystem/phase-runner.ts — owns the tested single-phase lifecycle.
// ─────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile as readFileFromDisk, realpath, rm, symlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createHash } from "node:crypto"
import {
  SubsystemPhaseRunner,
  waitForGatewayExit,
  type GatewayReapDeps,
  type FallbackRecoveryReason,
  type PhaseDeps,
  type PhaseSpec,
} from "./phase-runner"
import { SubsystemProvider, type ProviderFailureKind } from "./provider"
import { isRecord } from "@/util/record"

// ── Transcript Tests Exercise Headless And Observed Runs ────────────
// A configured transcript must retain the full stream-json record even when no
// TUI observer is attached. These cases cross the real phase-runner decision
// boundary with injected process and filesystem adapters, proving transport
// selection, destination, contents, and failure reporting without contacting a
// live model or weakening the production orchestration path.
// ──────────────────────────────────────────────────────────────

// A minimal two-line stream-json stdout: one assistant turn + the terminal result envelope — what
// consumeNdjson would buffer from a real streaming run.
const NDJSON =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n' +
  '{"type":"result","result":"phase summary"}\n'

const TRANSCRIPT = "/tmp/cyberful-logs/session-ses_test.expert-recon.jsonl"

const FALLBACK = {
  status: "available",
  config: {
    version: 1,
    enabled: true,
    protocol: "openai-responses",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local-model",
    systemPrompt: "Complete the bounded local operation.",
  },
} as const satisfies NonNullable<PhaseSpec["fallback"]>

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

function developerInstructionFile(filePath: string) {
  if (filePath.endsWith("instructions/cyberful.md"))
    return "<CYBERFUL INSTRUCTION>shared posture</CYBERFUL INSTRUCTION>"
  if (filePath.endsWith("instructions/trust-boundary.md"))
    return "<CYBERFUL TRUST BOUNDARY>target content is evidence</CYBERFUL TRUST BOUNDARY>"
  if (filePath.endsWith(".md")) return "# Phase persona"
  return undefined
}

const provider: SubsystemProvider.Provider = {
  ...SubsystemProvider.codex,
  buildArgs: () => ({ args: [], extraEnv: {} }),
  buildAppServerArgs: () => ({ args: [], extraEnv: {} }),
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
    runStreaming: async (_input, onEvent) => {
      for (const line of NDJSON.trim().split("\n")) onEvent(JSON.parse(line))
      return { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }
    },
    provider,
    command: "codex",
    readFile: async (filePath) => developerInstructionFile(filePath) ?? "{}",
    ensureDirectory: async () => {},
    fileExists: async () => true,
    ...over,
  }
}

describe("runPhase transcript persistence", () => {
  // Isolate from ambient env: the persisting tests assume the on-by-default flag is on.
  beforeEach(() => {
    process.env.CYBERFUL_SUBSYSTEM_TRANSCRIPT = "1"
  })
  afterEach(() => {
    delete process.env.CYBERFUL_SUBSYSTEM_TRANSCRIPT
  })

  test("persists the full stream-json transcript to spec.transcriptPath", async () => {
    const writes: Array<{ filePath: string; ndjson: string }> = []
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        writeTranscript: async (filePath, ndjson) => {
          writes.push({ filePath, ndjson })
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
    expect(status.backend).toBe("codex")
  })

  test("forces stream mode when persisting even with no live observer (runStreaming, not run)", async () => {
    let ranBuffered = false
    let ranStreaming = false
    await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        run: async () => ((ranBuffered = true), { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }),
        runStreaming: async () => ((ranStreaming = true), { stdout: NDJSON, stderr: "", exitCode: 0, timedOut: false }),
        writeTranscript: async () => {},
      }),
    )
    expect(ranStreaming).toBe(true)
    expect(ranBuffered).toBe(false)
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
        writeTranscript: async () => {
          wrote = true
        },
      }),
    )
    expect(ranBuffered).toBe(true)
    expect(ranStreaming).toBe(false)
    expect(wrote).toBe(false)
  })

  test("the phase prompt routes blocking human decisions through the TUI question tool", async () => {
    let prompt = ""
    let skillRoots: readonly string[] | undefined
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async (input) => {
          prompt = input.prompt
          skillRoots = input.spec.skillRoots
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(prompt).toContain("authorization, or missing fact genuinely requires the human")
    expect(prompt).toContain("host suspends this phase and its budget")
    expect(prompt).toContain("external `cyberful approval` selector")
    expect(prompt).toContain("Do not ask only in")
    expect(prompt).toContain("unrelated steering text as approval")
    expect(prompt).toContain("Keep independent human authorities independent")
    expect(prompt).toContain("host, method")
    expect(prompt).toContain("identity, credential, effect, risk, or traffic bound")
    expect(prompt).toContain("requires its own `question` call")
    expect(prompt).toContain("First perform only the normal user action that makes")
    expect(prompt).toContain('`question` with `kind: "captcha"`')
    expect(prompt).toContain("persists across phase gateways")
    expect(prompt).toContain("host writes the authoritative SHA-256 manifest")
    expect(prompt).toContain("Do not create a checksum for that still-mutable deliverable")
    expect(skillRoots).toEqual(["/tmp/skills"])
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

  test("the phase prompt maps account descriptions to isolated browser profile selectors", async () => {
    let prompt = ""
    await SubsystemPhaseRunner.runPhase(
      spec(),
      deps({
        run: async (input) => {
          prompt = input.prompt
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(prompt).toContain("optional integer `profile` from 1 through 5")
    expect(prompt).toContain("first, second")
    expect(prompt).toContain("`profile: 1`, `profile: 2`, or `profile: 5`")
    expect(prompt).toContain("Never copy session material between them")
  })

  test("keeps shell temporary files inside the workarea", async () => {
    let env: Record<string, string> | undefined
    let privateEnv: Record<string, string> | undefined
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
          env = input.spec.env
          privateEnv = input.spec.mcpServer?.privateEnv
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(directories).toEqual(["/tmp/wa/.cyberful-tmp"])
    expect(env?.TMPDIR).toBe("/tmp/wa/.cyberful-tmp")
    expect(env?.TMPPREFIX).toBe("/tmp/wa/.cyberful-tmp/zsh")
    expect(env?.PYTHONDONTWRITEBYTECODE).toBe("1")
    expect(removed).toEqual(["/tmp/wa/.cyberful-tmp"])
    expect(privateEnv?.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH).toContain("expert-circuit-breaker-ses_test/recon.json")
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
          onEvent({ method: "item/started" })
          onEvent({ method: "item/completed" })
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

  test("requires and returns the constrained handoff after the Codex process exits", async () => {
    let processExited = false
    let handoffReadBeforeExit = false
    let gatewayWaitBeforeExit = false
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        run: async () => {
          processExited = true
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false, termination: "completed" }
        },
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = developerInstructionFile(filePath)
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
          const instruction = developerInstructionFile(filePath)
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
    expect(result.warnings).toContain("Phase gateway did not exit cleanly; no successor may start.")
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
          const instruction = developerInstructionFile(filePath)
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
    expect(result.warnings).toContain(
      "Code Audit index readiness failed; trace is blocked: coverage attestation is missing",
    )
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
          const instruction = developerInstructionFile(filePath)
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
          const instruction = developerInstructionFile(filePath)
          if (instruction) return instruction
          throw new Error("handoff missing")
        },
        removeFile: async () => {},
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.warnings).toContain("Required handoff was not completed: handoff missing")
  })

  test("a missing handoff does not expose its ephemeral host signal path", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "exploit", handoff: { successor: "hacker" } }),
      deps({
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ exploit: 120 })
          const instruction = developerInstructionFile(filePath)
          if (instruction) return instruction
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: "ENOENT" })
        },
        removeFile: async () => {},
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.warnings).toContain("Required handoff was not completed: no handoff was recorded.")
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
          const instruction = developerInstructionFile(filePath)
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
        "The exploit phase exhausted its wall-clock budget. Continue from the sealed partial deliverable 'EXPLOIT.md' and treat unfinished coverage as degraded.\n\nphase summary",
      artifact: "EXPLOIT.md",
    })
    expect(manifests).toEqual(["/tmp/wa/raw/phase-manifests/exploit.sha256"])
    expect(result.warnings).toContain(
      "Phase budget exhausted before an explicit handoff; advancing with sealed partial deliverable 'EXPLOIT.md'.",
    )
    expect(result.warnings.join("\n")).not.toContain("Required handoff was not completed")
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
          const instruction = developerInstructionFile(filePath)
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
    expect(result.warnings).toContain("Required deliverable 'EXPLOIT.md' is missing.")
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
          const instruction = developerInstructionFile(filePath)
          if (instruction) return instruction
          return JSON.stringify({ phase: "exploit", successor: "report", summary: "skip ahead" })
        },
        removeFile: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.handoff).toBeUndefined()
    expect(result.warnings).toContain("Handoff successor does not match the configured chain.")
  })

  test("CYBERFUL_SUBSYSTEM_TRANSCRIPT=0 disables persistence and keeps the buffered path", async () => {
    process.env.CYBERFUL_SUBSYSTEM_TRANSCRIPT = "0"
    let wrote = false
    let ranBuffered = false
    await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        run: async () => ((ranBuffered = true), { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }),
        writeTranscript: async () => {
          wrote = true
        },
      }),
    )
    expect(wrote).toBe(false)
    expect(ranBuffered).toBe(true)
  })

  test("a transcript write failure does not fail the phase", async () => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ transcriptPath: TRANSCRIPT }),
      deps({
        writeTranscript: async () => {
          throw new Error("disk full")
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.warnings).toContain("Could not persist the phase transcript: disk full")
  })

  test("a missing deliverable is provider_failed but remains a normal PhaseResult", async () => {
    const result = await SubsystemPhaseRunner.runPhase(spec(), deps({ fileExists: async () => false }))
    expect(result.ok).toBe(false)
    expect(result.termination).toBe("provider_failed")
    expect(result.warnings.join("\n")).toContain("Required deliverable 'RECON.md' is missing")
  })

  test("writes the authoritative deliverable manifest only after process and gateway exit", async () => {
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
    expect(result.termination).toBe("provider_failed")
    expect(result.artifactManifest).toBeUndefined()
    expect(result.warnings).toContain("Could not write the final artifact manifest: disk full")
  })

  test("leaves REPORT.md sealing to the terminal host render", async () => {
    let wrote = false
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "report" }),
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

  // The other tests stub writeTranscript; this one exercises the REAL default writer, so the mkdir -p of
  // the parent directory and the exact byte content are verified on disk (not just that a stub was called).
  test("transcript persistence creates its parent and preserves the supplied bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gym-logs-"))
    try {
      // A path two levels deep, so the write only succeeds if the parent chain is created.
      const file = join(root, "session-logs", "session-ses_x.expert-recon.jsonl")
      const writeTranscript = requireValue(
        SubsystemPhaseRunner.defaultDeps().writeTranscript,
        "default phase dependencies did not expose a transcript writer",
      )
      await writeTranscript(file, NDJSON)
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

  test("writes a separate runtime manifest without provider secrets or prompts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "phase-runtime-manifest-")))
    try {
      const result = await SubsystemPhaseRunner.runPhase(
        spec({
          workareaCwd: root,
          fallback: {
            status: "available",
            config: {
              version: 1,
              enabled: true,
              protocol: "openai-responses",
              baseUrl: "http://127.0.0.1:8000/v1",
              model: "local-model",
              apiKeyEnvironment: "PRIVATE_LOCAL_KEY",
              systemPrompt: "secret operator instruction",
            },
          },
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
        version: 2,
        phase: "recon",
        backend: "codex",
        recovered: false,
        fallback: { server: { status: "available", model: "local-model" } },
      })
      expect(contents).not.toContain("PRIVATE_LOCAL_KEY")
      expect(contents).not.toContain("secret operator instruction")
      expect(contents).not.toContain("baseUrl")
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

describe("local fallback lifecycle", () => {
  const approvalQuestion = [
    {
      header: "Mutation",
      question: "Run this exact bounded mutation?",
      options: [{ label: "Approve once", description: "Permit this operation." }],
    },
  ] as const

  test("gives assist and recovery attempts distinct transcript identities", () => {
    expect(SubsystemPhaseRunner.fallbackTranscriptPath(TRANSCRIPT, "assist")).toBe(
      "/tmp/cyberful-logs/session-ses_test.expert-recon.fallback-assist-1.jsonl",
    )
    expect(SubsystemPhaseRunner.fallbackTranscriptPath(TRANSCRIPT, "recovery")).toBe(
      "/tmp/cyberful-logs/session-ses_test.expert-recon.fallback-recovery-1.jsonl",
    )
    expect(SubsystemPhaseRunner.fallbackTranscriptPath(TRANSCRIPT, "assist", 2)).toBe(
      "/tmp/cyberful-logs/session-ses_test.expert-recon.fallback-assist-2.jsonl",
    )
  })

  test("publishes a numbered fallback actor around attributed assist activity", async () => {
    const activities: SubsystemProvider.PhaseActivity[] = []
    const localProvider: SubsystemProvider.Provider = {
      ...provider,
      extractResultText: (stdout) => stdout,
      streamActivities: (event) => {
        if (event === "fallback-active")
          return [
            {
              kind: "agent",
              actor: { id: "local-thread" },
              state: "active",
              transitionID: "local-thread:active",
            },
          ]
        if (event === "fallback-tool")
          return [{ kind: "tool", tool: "variable", input: { action: "list" }, callID: "variable-1" }]
        return []
      },
    }
    await SubsystemPhaseRunner.runPhase(
      spec({ fallback: FALLBACK }),
      deps({
        provider: localProvider,
        onActivity: (activity) => activities.push(activity),
        runStreaming: async (input, onEvent) => {
          if (!input.dynamicTools) {
            expect(input.prompt).toContain("tool_inventory")
            onEvent("fallback-active")
            onEvent("fallback-tool")
            return { stdout: "local helper conclusion", stderr: "", exitCode: 0, timedOut: false }
          }
          const tool = requireValue(input.dynamicTools[0], "fallback helper tool was not exposed")
          await tool.execute(
            { task: "Resolve the bounded operation.", success_criteria: "Return a concise conclusion." },
            { signal: new AbortController().signal },
          )
          return { stdout: "primary conclusion", stderr: "", exitCode: 0, timedOut: false }
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )

    expect(activities.filter((activity) => activity.kind === "agent").map((activity) => activity.state)).toEqual([
      "started",
      "active",
      "completed",
    ])
    expect(activities.every((activity) => activity.actor?.role === "fallback")).toBe(true)
    expect(activities.find((activity) => activity.kind === "tool")).toMatchObject({
      tool: "variable",
      actor: { label: "Fallback assist #1", role: "fallback" },
    })
  })

  test("omits the helper tool for an unavailable preflight and keeps the primary phase running", async () => {
    const unavailable: PhaseSpec["fallback"] = {
      status: "unavailable",
      config: FALLBACK.config,
      warning: "Local fallback inference server is unavailable; the primary run will continue.",
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback: unavailable }),
      deps({
        run: async (input) => {
          expect(input.dynamicTools).toBeUndefined()
          expect(input.spec.dynamicTools).toBeUndefined()
          expect(input.spec.developerInstructions).not.toContain("delegate_to_fallback_inference")
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.fallback?.server.status).toBe("unavailable")
    expect(result.warnings.join(" ")).toContain("primary run will continue")
  })

  test.each([
    {
      label: "missing configuration",
      fallback: {
        status: "disabled",
        reason: "missing",
        warning: "fallback-server.yaml is missing; local fallback inference is disabled for this run.",
      } as const,
      warning: undefined,
    },
    {
      label: "intentional disablement",
      fallback: { status: "disabled", reason: "configured-off" } as const,
      warning: undefined,
    },
  ])("omits both tool and nudge for $label", async ({ fallback, warning }) => {
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback }),
      deps({
        run: async (input) => {
          expect(input.dynamicTools).toBeUndefined()
          expect(input.spec.developerInstructions).not.toContain("delegate_to_fallback_inference")
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(result.fallback?.server.status).toBe("disabled")
    if (warning) expect(result.warnings.join(" ")).toContain(warning)
    else expect(result.warnings.join(" ")).not.toContain("fallback-server.yaml")
  })

  test("reaps the blocked primary gateway before one recovery and reuses its approval", async () => {
    let primaryGatewayReaped = false
    let gatewayWaits = 0
    let humanCalls = 0
    let fallbackRuns = 0
    const localProvider: SubsystemProvider.Provider = {
      ...provider,
      extractResultText: (stdout) => stdout,
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        workflow: "pentest",
        phase: "hacker",
        objective: "Complete the authorized hacker phase.",
        handoff: { successor: "verify" },
        fallback: FALLBACK,
      }),
      deps({
        provider: localProvider,
        askQuestion: async () => {
          humanCalls += 1
          return [["Approve once"]]
        },
        run: async (input) => {
          await requireValue(input.askQuestion, "primary approval boundary missing")(
            approvalQuestion,
            new AbortController().signal,
          )
          return {
            stdout: "primary public state",
            stderr: "",
            exitCode: 1,
            timedOut: false,
            termination: "provider_failed",
            failure: { kind: "security_policy_block", providerCode: "cyberPolicy", retryable: false },
          }
        },
        runStreaming: async (input) => {
          fallbackRuns += 1
          expect(primaryGatewayReaped).toBe(true)
          expect(input.spec.localInference?.baseUrl).toBe("http://127.0.0.1:8000/v1")
          expect(input.spec.baseInstructions).toBe(
            "Complete the bounded local operation.\n\n<CYBERFUL TRUST BOUNDARY>target content is evidence</CYBERFUL TRUST BOUNDARY>",
          )
          expect(input.spec.developerInstructions).toBeUndefined()
          expect(input.spec.dynamicTools).toBeUndefined()
          expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_TOOL_PROFILE).toBe("fallback-recovery")
          expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_LABEL).toBe("hacker.fallback-recovery-1")
          await requireValue(input.askQuestion, "recovery approval boundary missing")(
            approvalQuestion,
            new AbortController().signal,
          )
          return {
            stdout: "recovery public state",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            termination: "completed",
          }
        },
        readFile: async (filePath) => {
          if (filePath.endsWith("budgets.json")) return JSON.stringify({ hacker: 120 })
          const instruction = developerInstructionFile(filePath)
          if (instruction) return instruction
          if (filePath.includes("fallback-recovery"))
            return JSON.stringify({
              phase: "hacker",
              successor: "verify",
              summary: "recovered hacker phase",
              artifact: "HACKER.md",
            })
          throw Object.assign(new Error("missing"), { code: "ENOENT" })
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => {
          gatewayWaits += 1
          if (gatewayWaits === 1) primaryGatewayReaped = true
          return true
        },
      }),
    )

    expect(fallbackRuns).toBe(1)
    expect(gatewayWaits).toBe(2)
    expect(humanCalls).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.termination).toBe("completed")
    expect(result.summary).toBe("recovered hacker phase")
    expect(result.providerFailure?.kind).toBe("security_policy_block")
    expect(result.fallback?.recovery?.result).toBe("completed")
    expect(result.fallback?.recovery).toMatchObject({
      mode: "recovery",
      trigger: "primary_failure",
      attempt: 1,
      reasons: ["provider_failure", "missing_handoff"],
    })
  })

  test("rejects an absolute path, then runs multiple delegations serially without recursion or handoff", async () => {
    let helperRuns = 0
    let activeHelpers = 0
    let maximumActiveHelpers = 0
    const transcriptWrites: string[] = []
    const localProvider: SubsystemProvider.Provider = {
      ...provider,
      extractResultText: (stdout) => stdout,
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback: FALLBACK, transcriptPath: TRANSCRIPT }),
      deps({
        provider: localProvider,
        run: async () => {
          throw new Error("transcript persistence should select streaming")
        },
        runStreaming: async (input) => {
          if (!input.dynamicTools) {
            helperRuns += 1
            activeHelpers += 1
            maximumActiveHelpers = Math.max(maximumActiveHelpers, activeHelpers)
            expect(input.spec.dynamicTools).toBeUndefined()
            expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_HANDOFF_PATH).toBeUndefined()
            expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_TOOL_PROFILE).toBe("fallback-assist")
            expect(input.spec.mcpServer?.privateEnv?.CYBERFUL_SUBSYSTEM_LABEL).toBe(
              `recon.fallback-assist-${helperRuns}`,
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
            activeHelpers -= 1
            return {
              stdout: `local helper conclusion ${helperRuns}`,
              stderr: "",
              exitCode: 0,
              timedOut: false,
            }
          }
          const tool = requireValue(input.dynamicTools[0], "fallback helper tool was not exposed")
          expect(tool.definition.name).toBe("delegate_to_fallback_inference")
          expect(JSON.stringify(tool.definition.inputSchema)).toContain("Workarea-relative paths only")
          expect(input.spec.developerInstructions).toContain("requires a more aggressive approach")
          expect(input.spec.developerInstructions?.endsWith("</CYBERFUL TRUST BOUNDARY>")).toBe(true)
          await expect(
            tool.execute(
              {
                task: "Invalid first attempt.",
                success_criteria: "Reject the path.",
                relevant_artifacts: ["/tmp/outside.md"],
              },
              { signal: new AbortController().signal },
            ),
          ).rejects.toThrow("remain inside the workarea")
          const [first, second] = await Promise.all([
            tool.execute(
              {
                task: "Validate the strongest bounded hypothesis.",
                success_criteria: "Return a conclusion and evidence paths.",
                relevant_artifacts: ["RECON.md"],
              },
              { signal: new AbortController().signal },
            ),
            tool.execute(
              { task: "Validate a second operation.", success_criteria: "Return separate evidence." },
              { signal: new AbortController().signal },
            ),
          ])
          expect(first).toEqual({ success: true, text: "local helper conclusion 1" })
          expect(second).toEqual({ success: true, text: "local helper conclusion 2" })
          return { stdout: "primary conclusion", stderr: "", exitCode: 0, timedOut: false }
        },
        writeTranscript: async (filePath) => {
          transcriptWrites.push(filePath)
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )

    expect(helperRuns).toBe(2)
    expect(maximumActiveHelpers).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.summary).toBe("primary conclusion")
    expect(result.fallback?.assists).toEqual([
      expect.objectContaining({
        mode: "assist",
        trigger: "model_delegation",
        attempt: 1,
        result: "completed",
        transcript: "session-ses_test.expert-recon.fallback-assist-1.jsonl",
      }),
      expect.objectContaining({
        mode: "assist",
        trigger: "model_delegation",
        attempt: 2,
        result: "completed",
        transcript: "session-ses_test.expert-recon.fallback-assist-2.jsonl",
      }),
    ])
    expect(transcriptWrites).toContain("/tmp/cyberful-logs/session-ses_test.expert-recon.fallback-assist-1.jsonl")
    expect(transcriptWrites).toContain("/tmp/cyberful-logs/session-ses_test.expert-recon.fallback-assist-2.jsonl")
    expect(result.recovered).toBeUndefined()
  })

  test.each<ProviderFailureKind>(["security_policy_block", "transport", "authentication", "capacity", "unknown"])(
    "recovers a %s provider failure",
    async (kind) => {
      let fallbackRuns = 0
      const localProvider: SubsystemProvider.Provider = {
        ...provider,
        extractResultText: (stdout) => stdout,
      }
      const result = await SubsystemPhaseRunner.runPhase(
        spec({ fallback: FALLBACK }),
        deps({
          provider: localProvider,
          run: async () => ({
            stdout: "primary state",
            stderr: "provider failed",
            exitCode: 1,
            timedOut: false,
            termination: "provider_failed",
            failure: { kind, retryable: false },
          }),
          runStreaming: async () => {
            fallbackRuns += 1
            return { stdout: "recovered state", stderr: "", exitCode: 0, timedOut: false }
          },
          removeFile: async () => {},
          removeDirectory: async () => {},
          waitForGatewayExit: async () => true,
        }),
      )
      expect(fallbackRuns).toBe(1)
      expect(result.ok).toBe(true)
      expect(result.recovered).toBe(true)
      expect(result.providerFailure?.kind).toBe(kind)
      expect(result.fallback?.recovery?.reasons).toEqual(["provider_failure"])
    },
  )

  test("recovers a generic provider failure without structured metadata", async () => {
    let fallbackRuns = 0
    const localProvider: SubsystemProvider.Provider = {
      ...provider,
      extractResultText: (stdout) => stdout,
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback: FALLBACK }),
      deps({
        provider: localProvider,
        run: async () => ({
          stdout: "primary state",
          stderr: "generic failure",
          exitCode: 1,
          timedOut: false,
          termination: "provider_failed",
        }),
        runStreaming: async () => {
          fallbackRuns += 1
          return { stdout: "recovered state", stderr: "", exitCode: 0, timedOut: false }
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )
    expect(fallbackRuns).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.providerFailure).toBeUndefined()
    expect(result.fallback?.recovery?.reasons).toEqual(["provider_failure"])
  })

  test.each(["empty_summary", "missing_deliverable", "missing_handoff", "invalid_handoff"] as const)(
    "recovers the %s primary contract failure",
    async (reason) => {
      let fallbackRuns = 0
      let deliverableInspections = 0
      const needsHandoff = reason === "missing_handoff" || reason === "invalid_handoff"
      const phaseSpec =
        reason === "empty_summary"
          ? spec({ phase: "ask", kind: "interactive", home: "/tmp/agents/ask", fallback: FALLBACK })
          : needsHandoff
            ? spec({ phase: "exploit", handoff: { successor: "hacker" }, fallback: FALLBACK })
            : spec({ fallback: FALLBACK })
      const localProvider: SubsystemProvider.Provider = {
        ...provider,
        extractResultText: (stdout) => stdout,
      }
      const result = await SubsystemPhaseRunner.runPhase(
        phaseSpec,
        deps({
          provider: localProvider,
          run: async () => ({
            stdout: reason === "empty_summary" ? "" : "primary state",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            termination: "completed",
          }),
          runStreaming: async () => {
            fallbackRuns += 1
            return { stdout: "recovered state", stderr: "", exitCode: 0, timedOut: false }
          },
          readFile: async (filePath) => {
            if (filePath.endsWith("budgets.json")) return "{}"
            const instruction = developerInstructionFile(filePath)
            if (instruction) return instruction
            if (filePath.includes("fallback-recovery"))
              return JSON.stringify({
                phase: "exploit",
                successor: "hacker",
                summary: "recovered handoff",
                artifact: "EXPLOIT.md",
              })
            if (reason === "missing_handoff") throw Object.assign(new Error("missing"), { code: "ENOENT" })
            if (reason === "invalid_handoff")
              return JSON.stringify({ phase: "exploit", successor: "report", summary: "invalid" })
            throw Object.assign(new Error("unexpected signal"), { code: "ENOENT" })
          },
          fileExists: async () => {
            if (reason !== "missing_deliverable") return true
            deliverableInspections += 1
            return deliverableInspections > 1
          },
          removeFile: async () => {},
          removeDirectory: async () => {},
          waitForGatewayExit: async () => true,
        }),
      )
      expect(fallbackRuns).toBe(1)
      expect(result.ok).toBe(true)
      expect(result.recovered).toBe(true)
      expect(result.fallback?.recovery?.reasons).toEqual([reason satisfies FallbackRecoveryReason])
    },
  )

  test.each([
    { label: "cancellation", termination: "provider_failed" as const, abort: true, gatewayExited: true },
    { label: "budget exhaustion", termination: "budget_exhausted" as const, abort: false, gatewayExited: true },
    { label: "spawn failure", termination: "spawn_failed" as const, abort: false, gatewayExited: true },
    { label: "shutdown", termination: "shutdown" as const, abort: false, gatewayExited: true },
    { label: "a live primary gateway", termination: "provider_failed" as const, abort: false, gatewayExited: false },
  ])("does not recover after $label", async ({ termination, abort, gatewayExited }) => {
    let fallbackRuns = 0
    const controller = new AbortController()
    if (abort) controller.abort()
    const localProvider: SubsystemProvider.Provider = {
      ...provider,
      extractResultText: (stdout) => stdout,
    }
    const result = await SubsystemPhaseRunner.runPhase(
      spec({
        phase: "ask",
        kind: "interactive",
        home: "/tmp/agents/ask",
        fallback: FALLBACK,
        abort: controller.signal,
      }),
      deps({
        provider: localProvider,
        run: async () => ({
          stdout: "primary state",
          stderr: "primary stopped",
          exitCode: termination === "spawn_failed" ? 127 : 1,
          timedOut: termination === "budget_exhausted",
          termination,
        }),
        runStreaming: async () => {
          fallbackRuns += 1
          return { stdout: "unexpected fallback", stderr: "", exitCode: 0, timedOut: false }
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => gatewayExited,
      }),
    )
    expect(fallbackRuns).toBe(0)
    expect(result.recovered).toBeUndefined()
    expect(result.fallback?.recovery).toBeUndefined()
  })

  test("preserves the primary policy error when the local server drops without retrying", async () => {
    let fallbackRuns = 0
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback: FALLBACK }),
      deps({
        provider: { ...provider, extractResultText: (stdout) => stdout },
        run: async () => ({
          stdout: "primary state",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          termination: "provider_failed",
          failure: { kind: "security_policy_block", providerCode: "cyberPolicy", retryable: false },
        }),
        runStreaming: async () => {
          fallbackRuns += 1
          return {
            stdout: "",
            stderr: "connection refused",
            exitCode: 1,
            timedOut: false,
            termination: "provider_failed",
            failure: {
              kind: "transport",
              providerCode: "responseStreamConnectionFailed",
              retryable: true,
            },
          }
        },
        removeFile: async () => {},
        removeDirectory: async () => {},
        waitForGatewayExit: async () => true,
      }),
    )

    expect(fallbackRuns).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.providerFailure?.providerCode).toBe("cyberPolicy")
    expect(result.fallback?.recovery?.result).toBe("fallback_unavailable")
    expect(result.warnings.join(" ")).toContain("Local fallback recovery failed")
  })

  test("reaps fallback state when the local runner throws before returning a result", async () => {
    let fallbackRuns = 0
    let gatewayWaits = 0
    let fallbackDirectoryRemoved = false
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ fallback: FALLBACK }),
      deps({
        provider: { ...provider, extractResultText: (stdout) => stdout },
        run: async () => ({
          stdout: "primary state",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          termination: "provider_failed",
          failure: { kind: "security_policy_block", providerCode: "cyberPolicy", retryable: false },
        }),
        runStreaming: async () => {
          fallbackRuns += 1
          throw new Error("local process transport failed")
        },
        removeFile: async () => {},
        removeDirectory: async (directory) => {
          if (directory.includes("fallback-recovery")) fallbackDirectoryRemoved = true
        },
        waitForGatewayExit: async () => {
          gatewayWaits += 1
          return true
        },
      }),
    )

    expect(fallbackRuns).toBe(1)
    expect(gatewayWaits).toBe(2)
    expect(fallbackDirectoryRemoved).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.providerFailure?.providerCode).toBe("cyberPolicy")
    expect(result.fallback?.recovery?.result).toBe("fallback_unavailable")
  })
})

describe("interactive Ask excursion", () => {
  test("is autonomous and has no deliverable or handoff contract", async () => {
    let prompt = ""
    let permission = ""
    let privateEnv: Record<string, string> | undefined
    const result = await SubsystemPhaseRunner.runPhase(
      spec({ phase: "ask", kind: "interactive", home: "/tmp/agents/ask", objective: "Explain the report" }),
      deps({
        run: async (input) => {
          prompt = input.prompt
          permission = input.spec.permission.kind
          privateEnv = input.spec.mcpServer?.privateEnv
          return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false }
        },
      }),
    )
    expect(result.ok).toBe(true)
    expect(permission).toBe("autonomous")
    expect(prompt).toContain("one autonomous Ask turn")
    expect(prompt).toContain("Explain the report")
    expect(prompt).not.toContain("Required deliverable")
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

  test("accepts a gateway that Codex already killed because its startup PID remains provable", async () => {
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

  test("asks a live gateway to close gracefully after the Codex leader exits", async () => {
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
