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
  type PhaseDeps,
  type PhaseSpec,
} from "./phase-runner"
import type { SubsystemProvider } from "./provider"
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
  if (filePath.endsWith(".md")) return "# Phase persona"
  return undefined
}

const provider: SubsystemProvider.Provider = {
  name: "codex",
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
    expect(prompt).toContain("`question` and continue from the answer shown through the TUI")
    expect(prompt).toContain("Do not ask only in prose and stop")
    expect(prompt).toContain("First perform only the normal user action that makes")
    expect(prompt).toContain('`question` with `kind: "captcha"`')
    expect(prompt).toContain("persists across phase gateways")
    expect(prompt).toContain("host writes the authoritative SHA-256 manifest")
    expect(prompt).toContain("Do not create a checksum for that still-mutable deliverable")
    expect(skillRoots).toEqual(["/tmp/skills"])
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
      const assessment = SubsystemPhaseRunner.artifactManifestPath({
        workflow: "assessment",
        phase: "verify",
        workareaCwd: root,
      })
      const remediate = SubsystemPhaseRunner.artifactManifestPath({
        workflow: "remediate",
        phase: "verify",
        workareaCwd: root,
      })
      expect(assessment).toBe(join(root, "raw", "phase-manifests", "assessment", "verify.sha256"))
      expect(remediate).toBe(join(root, "raw", "phase-manifests", "remediate", "verify.sha256"))
      expect(assessment).not.toBe(remediate)
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
