// ── Pi Phase Runner ───────────────────────────────────────────────
// Runs one phase with its persona and gateway, then validates process
// exit, required artifact, handoff or budget cutoff, cleanup, and transcript results.
// → cyberful/src/subsystem/phase.ts — supplies workflow policy, capability scope, and paths.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "path"
import os from "os"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { readFile, mkdir, access, rm, lstat, open } from "fs/promises"
import { Settings } from "@/config/settings"
import { Subsystem } from "./subsystem"
import { SubsystemCli } from "./cli"
import { SubsystemGateway } from "./gateway/config"
import { SubsystemPhase } from "./phase"
import type { AskHuman } from "./human-question"
import { SubsystemPhaseBudgetClock } from "./phase-budget-clock"
import { SubsystemCompletion, type Candidate as CompletionCandidate } from "./completion"
import { SubsystemNovelty, type Contract as NoveltyContract } from "./novelty"
import { SubsystemUsage, type ContextChurn, type Totals as UsageTotals } from "./usage"
import { SubsystemVerdict, type Ledger as VerdictLedger } from "./verdict"
import {
  parseHandoffSnapshot,
  type HandoffSnapshotV2,
} from "./handoff-snapshot"
import type { DynamicTool, SubsystemFailure } from "./subsystem"
import { verifyCodeGraphReadiness } from "./gateway/code-graph-tools"
import { ensureWorkareaDirectory, replaceWorkareaFile } from "@/workarea"
import { AgentPromptCompiler, type PromptManifest } from "./prompt-compiler"
import { PiSkills, type SkillRegistry } from "./pi-skills"
import { SubsystemPiAgent } from "./pi-agent"
import type { AgentRunResult } from "./agent-subsystem"
import { RunStateArtifact } from "./run-state-artifact"

export interface PhaseSpec {
  phase: string
  workflow?: string
  kind?: "workflow" | "interactive"
  sessionID: string
  // The workarea directory; writes are physically jailed here (it is the worker's cwd).
  workareaCwd: string
  // Read-only project root published only to the private gateway. Every AgentRun remains confined to
  // the workarea and must use source tools rather than host file writes against this path.
  sourceRoot?: string
  // The first-party agents directory holding this phase's persona and embedded policy.
  home: string
  // Directory containing the operator-owned settings.yaml. Defaults to the
  // Cyberful launch directory rather than the assessed project.
  settingsDirectory?: string
  // What this phase must accomplish, seeded from the prior handoff.
  objective: string
  timeoutMs: number
  // Recovery attempts use a fresh owner and may switch to the configured fallback route.
  attempt?: number
  providerRoute?: "main" | "fallback"
  // Host-owned cumulative waits from prior owners of the same phase. Recovery
  // inherits these counters so it cannot reset the shared extension pool.
  budgetCarry?: {
    readonly approvalWaitMs: number
    readonly retryWaitMs: number
    readonly targetCooldownWaitMs: number
    readonly phaseExtensionMs: number
    readonly recoveryExtensionMs?: number
    readonly recoveryChainIDs?: readonly string[]
  }
  abort?: AbortSignal
  // Absolute file to persist this excursion's raw AgentEvent transcript to (the caller resolves it,
  // normally beside the session journal via SessionReportLog.expertTranscriptFile). Unset ⇒ no
  // transcript is kept and the phase may take the cheaper buffered path.
  transcriptPath?: string
  // Private environment for the phase gateway and its upstreams. It is deliberately excluded from
  // AgentRun context: recon routing and ZAP keys are capabilities, not model-readable secrets.
  env?: Record<string, string>
  // Every chain phase must explicitly call the gateway's handoff tool.
  // The host records the request out-of-band, shuts down the in-process phase owner, then validates the
  // requested successor before the orchestrator advances.
  handoff?: { successor?: string }
}

export interface PhaseHandoff {
  phase: string
  successor?: string
  summary: string
  artifact?: string
  completion?: CompletionCandidate
  verdicts?: VerdictLedger
  snapshot?: HandoffSnapshotV2
}

export type PhaseFailureSource = "provider" | "contract" | "lifecycle" | "upstream"

export interface PhaseFailure {
  readonly phase: string
  readonly source: PhaseFailureSource
  readonly class: string
  readonly code?: string
  readonly detail: string
  readonly retryable?: boolean
}

export interface PhaseResult {
  phase: string
  // Authorizes the orchestrator to accept this phase's handoff. A budget-exhausted phase can remain
  // degraded while passing this gate after the host seals its partial artifact and synthesizes a handoff.
  ok: boolean
  // The phase's final reply text (its structured handoff summary), envelope already unwrapped.
  summary: string
  exitCode: number
  timedOut: boolean
  termination: SubsystemCli.RunTermination
  backend: string
  durationMs: number
  limitMs: number
  effectiveLimitMs: number
  deadlineAt: number
  // Non-execution waits are excluded from durationMs and extend deadlineAt by their union.
  approvalWaitMs?: number
  retryWaitMs?: number
  targetCooldownWaitMs?: number
  retryCompensationMs?: number
  retryCompensationCapMs?: number
  retryCompensationCapReached?: boolean
  recoveryExtensionMs?: number
  closeoutReserveMs?: number
  warnings: string[]
  handoff?: PhaseHandoff
  // Relative path to the host-generated SHA-256 manifest for the final named deliverable. The host
  // writes it only after the Pi worker owner has shut down and the gateway is gone, so it cannot
  // race a last agent edit.
  artifactManifest?: string
  // Host-owned runtime provenance; unlike the deliverable checksum this is JSON status evidence.
  runtimeManifest?: string
  // Tool activity is not progress by itself. These fields count only distinct host-observed contents of
  // the required deliverable, each saved as an atomic last-known-good checkpoint while the phase runs.
  semanticCheckpoints?: number
  lastSemanticProgressAt?: number
  subsystemFailure?: SubsystemFailure
  // One authoritative terminal cause drives orchestration and presentation.
  // Additional non-primary degradation remains in warnings.
  phaseFailure?: PhaseFailure
  // Subsystem-neutral counters and derived context-reuse metrics cover the phase
  // root and its descendant AgentRuns.
  usage?: UsageTotals
  contextChurn?: ContextChurn
  reasoningObservability?: {
    readonly items: number
    readonly summaryItems: number
    readonly contentItems: number
    readonly deltaItems: number
    readonly textStatus: "published" | "only counters received" | "no reasoning observed"
  }
  agentRun?: {
    readonly id: string
    readonly provider: string
    readonly model: string
    readonly providerAffinity: "main" | "fallback"
    readonly reasoningEffort?: Settings.ReasoningEffort
    readonly effectiveReasoningEffort?: string
    readonly context?: AgentRunResult["context"]
    readonly promptManifest: PromptManifest
    readonly childRunIDs: readonly string[]
    readonly skillsUsed: readonly string[]
    readonly toolCalls: number
    readonly fallbackAdmissions: number
    readonly fallbackDescendants: number
  }
  noveltyContract?: NoveltyContract
  recoveryPolicy?: {
    readonly enabled: boolean
    readonly maxRestarts: number
    readonly useFallbackProvider: boolean
    readonly fallbackConfigured: boolean
    readonly automaticSecurityBlockEnabled?: boolean
    readonly recoveryBonusMs?: number
  }
}

export interface SemanticProgress {
  phase: string
  artifact: string
  checkpoint: string
  sha256: string
  count: number
  timestamp: number
}

export interface TranscriptWriter {
  append(line: string): Promise<void>
  close(): Promise<void>
}

// Injected so the spawn contract is testable without a live external CLI or real filesystem.
export interface PhaseDeps {
  run: typeof SubsystemCli.run
  runStreaming: typeof SubsystemCli.runStreaming
  subsystem: Subsystem.Subsystem
  loadSettings: (directory: string) => Promise<Settings.Info>
  discoverSkills: (roots: readonly string[]) => Promise<SkillRegistry>
  // Reads budgets.json. Injected so budget resolution remains testable.
  readFile: (filePath: string) => Promise<string>
  // Reads the private gateway's first required-upstream failure marker. Kept
  // separate from workarea/config reads so small test adapters cannot
  // accidentally synthesize a marker for every phase.
  readUpstreamFailureSignal?: (filePath: string) => Promise<string>
  // Shells may materialize heredocs before the command runs. Production creates their private temporary
  // directory inside the already-authorized workarea so this preparation cannot escape the sandbox.
  ensureDirectory: (directory: string) => Promise<void>
  // Production validates the named deliverable on disk; optional only so narrowly-scoped test adapters
  // predating this check can opt out instead of emulating a filesystem.
  fileExists?: (filePath: string) => Promise<boolean>
  writeArtifactManifest?: (manifestPath: string, artifactPath: string) => Promise<void>
  writeRuntimeManifest?: (manifestPath: string, workarea: string, result: PhaseResult) => Promise<void>
  writeArtifactCheckpoint?: (checkpointPath: string, artifactPath: string) => Promise<string>
  now?: () => number
  removeFile?: (filePath: string) => Promise<void>
  removeDirectory?: (directory: string) => Promise<void>
  // Production reads the gateway's startup PID, reaps its process group after the in-process Pi owner
  // closes its bridge, and proves the group is gone. A handoff phase requires the registration because it
  // necessarily used the gateway.
  waitForGatewayExit?: (signalPath: string, timeoutMs: number, registrationRequired: boolean) => Promise<boolean>
  // When set, the phase streams every activity item mapped from AgentRun events
  // (subsystem.streamActivities) as it happens, so the TUI shows the phase
  // working live. Unset (the default) runs the CLI buffered.
  onActivity?: (activity: Subsystem.PhaseActivity) => void
  onSemanticProgress?: (progress: SemanticProgress) => void
  // Opens one private append-only transcript owned by the phase.
  createTranscript?: (filePath: string) => Promise<TranscriptWriter>
  // Production binds this to the session's in-process Question service. When absent (small unit adapters
  // and non-interactive callers), the gateway correctly omits `question` instead of exposing a dead tool.
  askQuestion?: AskHuman
  // The Code Audit index phase cannot authorize trace until source preflight and current graph coverage
  // match the gateway's host-keyed readiness attestation.
  verifyCodeGraphReadiness?: (environment: Readonly<Record<string, string | undefined>>) => Promise<unknown>
  // Host-owned structured tools are bound to the active session and phase. They
  // travel through the subsystem protocol without entering the phase gateway.
  dynamicTools?: readonly DynamicTool[]
  createRunState?: (input: {
    readonly workarea: string
    readonly workflow: string
    readonly phase: string
    readonly attempt: number
    readonly deadlineAt: number
  }) => Pick<RunStateArtifact, "start" | "fail">
  // Runs immediately before a phase owner and private gateway are created.
  // Host runtimes use it to attest and recover required upstream services.
  preparePhase?: (input: {
    readonly phase: string
    readonly attempt: number
    readonly signal?: AbortSignal
  }) => Promise<{ readonly warnings?: readonly string[]; readonly env?: Readonly<Record<string, string>> }>
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

async function operationWarning(label: string, operation?: () => Promise<void>) {
  if (!operation) return undefined
  try {
    await operation()
    return undefined
  } catch (error) {
    return `${label}: ${errorDetail(error)}`
  }
}

async function operationWarnings(operations: ReadonlyArray<readonly [string, (() => Promise<void>) | undefined]>) {
  const warnings = await Promise.all(operations.map(([label, operation]) => operationWarning(label, operation)))
  return warnings.filter((warning): warning is string => warning !== undefined)
}

export function defaultDeps(): PhaseDeps {
  return {
    run: SubsystemCli.run,
    runStreaming: SubsystemCli.runStreaming,
    subsystem: Subsystem.pi,
    loadSettings: Settings.load,
    discoverSkills: (roots) => PiSkills.discover({ roots }),
    readFile: (filePath) => readFile(filePath, "utf8"),
    readUpstreamFailureSignal: (filePath) => readFile(filePath, "utf8"),
    ensureDirectory: (directory) =>
      ensureWorkareaDirectory(path.dirname(directory), path.basename(directory)).then(() => {}),
    fileExists: pathExists,
    writeArtifactManifest,
    writeRuntimeManifest,
    writeArtifactCheckpoint,
    now: Date.now,
    removeFile: (filePath) => rm(filePath, { force: true }),
    removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
    waitForGatewayExit,
    verifyCodeGraphReadiness,
    createTranscript: async (filePath) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      const handle = await open(
        filePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
        0o600,
      )
      await handle.chmod(0o600)
      let queue = Promise.resolve()
      const failures: unknown[] = []
      return {
        append(line) {
          const task = queue.then(() => handle.write(line).then(() => {}))
          queue = task.catch((error) => {
            failures.push(error)
          })
          return queue
        },
        async close() {
          await queue
          await handle.close().catch((error) => {
            failures.push(error)
          })
          if (failures.length > 0)
            throw new AggregateError(failures, `phase transcript '${filePath}' could not be finalized`)
        },
      }
    },
    createRunState: (input) => new RunStateArtifact(input),
  }
}

export async function writeArtifactCheckpoint(checkpointPath: string, artifactPath: string) {
  const workarea = path.dirname(artifactPath)
  const relativeCheckpoint = containedArtifactPath(workarea, checkpointPath, "phase-checkpoints", [4, 5])
  const entry = await lstat(artifactPath)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("checkpoint artifact must be a regular file")
  const artifact = await open(
    artifactPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  const bytes = await artifact.readFile().finally(() => artifact.close())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await replaceWorkareaFile(workarea, relativeCheckpoint, bytes)
  return sha256
}

export async function writeArtifactManifest(manifestPath: string, artifactPath: string) {
  const workarea = path.dirname(artifactPath)
  const relativeManifest = containedArtifactPath(workarea, manifestPath, "phase-manifests", [3, 4])
  const artifactEntry = await lstat(artifactPath)
  if (!artifactEntry.isFile() || artifactEntry.isSymbolicLink())
    throw new Error("the required artifact must be a regular file, not a link")
  const artifact = await open(
    artifactPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  )
  const bytes = await artifact.readFile().finally(() => artifact.close())
  await replaceWorkareaFile(
    workarea,
    relativeManifest,
    `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(artifactPath)}\n`,
  )
}

export async function writeRuntimeManifest(manifestPath: string, workarea: string, result: PhaseResult) {
  const relativeManifest = containedArtifactPath(workarea, manifestPath, "phase-manifests", [3, 4])
  const payload = {
    version: 6,
    phase: result.phase,
    termination: result.termination,
    backend: result.backend,
    subsystemFailure: result.subsystemFailure,
    usage: result.usage,
    contextChurn: result.contextChurn,
    reasoningObservability: result.reasoningObservability,
    agentRun: result.agentRun,
    noveltyContract: result.noveltyContract,
    budget: {
      limitMs: result.limitMs,
      baseBudgetMs: result.limitMs,
      effectiveLimitMs: result.effectiveLimitMs,
      deadlineAt: result.deadlineAt,
      approvalWaitMs: result.approvalWaitMs ?? 0,
      humanWaitMs: result.approvalWaitMs ?? 0,
      retryWaitMs: result.retryWaitMs ?? 0,
      providerWaitMs: result.retryWaitMs ?? 0,
      targetCooldownWaitMs: result.targetCooldownWaitMs ?? 0,
      retryCompensationMs: result.retryCompensationMs ?? 0,
      phaseExtensionMs: result.retryCompensationMs ?? 0,
      recoveryExtensionMs: result.recoveryExtensionMs ?? 0,
      retryCompensationCapMs: result.retryCompensationCapMs ?? 0,
      phaseExtensionCapMs: result.retryCompensationCapMs ?? 0,
      retryCompensationCapReached: result.retryCompensationCapReached ?? false,
      closeoutReserveMs: result.closeoutReserveMs ?? 0,
      remainingMs: Math.max(0, result.deadlineAt - Date.now()),
      exitCause: result.termination,
    },
    verdicts: result.handoff?.verdicts ? SubsystemVerdict.counts(result.handoff.verdicts) : undefined,
    handoffSnapshot: result.handoff?.snapshot
      ? {
          version: result.handoff.snapshot.version,
          findingRegistryRevision: result.handoff.snapshot.findingRegistryRevision,
          hypothesisRegistryRevision: result.handoff.snapshot.hypothesisRegistryRevision,
          counts: result.handoff.snapshot.counts,
          digestSha256: result.handoff.snapshot.digestSha256,
        }
      : undefined,
  }
  await replaceWorkareaFile(workarea, relativeManifest, `${JSON.stringify(payload, null, 2)}\n`)
}

function containedArtifactPath(workarea: string, destination: string, directory: string, segmentCounts: number[]) {
  const relative = path.relative(path.resolve(workarea), path.resolve(destination))
  const segments = relative.split(path.sep)
  if (
    path.isAbsolute(relative) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !segmentCounts.includes(segments.length) ||
    segments[0] !== "raw" ||
    segments[1] !== directory ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`artifact ${directory} must stay in the workarea raw/${directory} directory`)
  return relative
}

export function artifactManifestPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd">) {
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-manifests",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    `${artifactPathSegment(spec.phase, "phase")}.sha256`,
  )
}

export function runtimeManifestPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd" | "attempt">) {
  const attempt = typeof spec.attempt === "number" && spec.attempt > 1 ? `.attempt-${spec.attempt}` : ""
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-manifests",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    `${artifactPathSegment(spec.phase, "phase")}${attempt}.runtime.json`,
  )
}

function phaseDeliverable(spec: Pick<PhaseSpec, "workflow" | "phase">) {
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase)
  return workflow ? SubsystemPhase.deliverableFor(workflow, spec.phase) : undefined
}

export function artifactCheckpointPath(spec: Pick<PhaseSpec, "workflow" | "phase" | "workareaCwd">) {
  return path.join(
    spec.workareaCwd,
    "raw",
    "phase-checkpoints",
    ...(spec.workflow ? [artifactPathSegment(spec.workflow, "workflow")] : []),
    artifactPathSegment(spec.phase, "phase"),
    phaseDeliverable(spec) ?? "artifact",
  )
}

function artifactPathSegment(value: string, label: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`Invalid ${label} artifact path segment '${value}'.`)
  return value
}

export function circuitBreakerDirectory(sessionID: string) {
  return path.join(os.tmpdir(), `expert-circuit-breaker-${sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-")}`)
}

export function circuitBreakerPath(sessionID: string, owner: string) {
  return path.join(circuitBreakerDirectory(sessionID), `${owner.replace(/[^a-zA-Z0-9_.-]/g, "-")}.json`)
}

export interface GatewayReapDeps {
  readSignal: (signalPath: string) => Promise<string>
  now: () => number
  sleep: (ms: number) => Promise<void>
  processAlive: (pid: number) => boolean
  processGroupAlive: (pid: number) => boolean
  signalProcess: (pid: number, signal: NodeJS.Signals) => void
  killTree: (pid: number, signal: NodeJS.Signals) => void
}

const gatewayReapDeps: GatewayReapDeps = {
  readSignal: (signalPath) => readFile(signalPath, "utf8"),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  processAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false
      if (errorCode(error) === "EPERM") return true
      throw error
    }
  },
  processGroupAlive: (pid) => {
    if (process.platform === "win32") return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false
      if (errorCode(error) === "EPERM") return true
      throw error
    }
  },
  signalProcess: (pid, signal) => {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error
    }
  },
  killTree: SubsystemCli.killTree,
}

async function waitUntilGatewayGone(pid: number, deadline: number, deps: GatewayReapDeps): Promise<boolean> {
  while (deps.now() <= deadline) {
    if (!deps.processAlive(pid) && !deps.processGroupAlive(pid)) return true
    await deps.sleep(20)
  }
  return !deps.processAlive(pid) && !deps.processGroupAlive(pid)
}

// ── Gateway Registration Survives Transport Close ───────────────
// The MCP transport may close unexpectedly, so an exit-time marker is
// inherently racy. The gateway instead registers its PID at startup. Once the
// in-process Pi worker owner has closed its bridge, first request a graceful
// gateway close; if any member of its process group survives, group-kill it
// before returning to the orchestrator.
// ─────────────────────────────────────────────────────────────────
export async function waitForGatewayExit(
  signalPath: string,
  timeoutMs: number,
  registrationRequired: boolean,
  deps: GatewayReapDeps = gatewayReapDeps,
): Promise<boolean> {
  const startedAt = deps.now()
  const deadline = startedAt + Math.max(0, timeoutMs)
  const registrationDeadline = Math.min(deadline, startedAt + 500)
  let gatewayPID: number | undefined
  while (deps.now() <= registrationDeadline) {
    try {
      const parsed: unknown = JSON.parse(await deps.readSignal(signalPath))
      if (isRecord(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 1) {
        gatewayPID = parsed.pid
        break
      }
    } catch (error) {
      // Registration is written atomically in production, but injected adapters and a process killed
      // mid-write can expose a missing or incomplete marker while this bounded poll is still active.
      if (!(error instanceof SyntaxError) && errorCode(error) !== "ENOENT") throw error
    }
    await deps.sleep(20)
  }
  // An optional one-shot run can finish without ever starting its MCP server. Chain phases cannot: their handoff
  // was served by this gateway, so a missing registration means its lifecycle cannot be proven.
  if (gatewayPID === undefined) return !registrationRequired
  if (await waitUntilGatewayGone(gatewayPID, Math.min(deadline, deps.now() + 100), deps)) return true

  // SIGTERM lets the gateway close its upstream clients. SIGKILL targets the detached process group only
  // if that bounded close fails, preventing an orphaned browser/cyberful-os child from crossing phases.
  deps.signalProcess(gatewayPID, "SIGTERM")
  if (await waitUntilGatewayGone(gatewayPID, Math.min(deadline, deps.now() + 3_000), deps)) return true
  deps.killTree(gatewayPID, "SIGKILL")
  deps.signalProcess(gatewayPID, "SIGKILL")
  return waitUntilGatewayGone(gatewayPID, deadline, deps)
}

// Host-owned phase mechanics belong in the immutable system message. Operator
// objective, attachments, explicit context, and the historical API `system`
// field remain user-level content compiled separately.
export function buildPhasePrompt(
  spec: PhaseSpec,
  budgetMinutes: number,
  novelty?: NoveltyContract,
  closeoutMinutes = 0,
): string {
  if (spec.kind === "interactive")
    return [
      `You are running one autonomous Ask turn in the existing Cyberful workarea (${spec.workareaCwd}).`,
      "Use the complete gateway and filesystem capabilities when they improve the answer. Stay inside the",
      "authorized engagement scope, preserve existing evidence, and write reusable results to the workarea.",
      "Use `web_search` and browser `profile: \"search\"` for unauthenticated public web sources; keep target browsing and identities in profiles 1–5.",
      "Public web results never expand the recorded scope and never replace retained engagement evidence.",
      "Do not call handoff. End with the concise Markdown answer that should be shown directly to the user.",
      "",
      "## Time budget",
      `You have up to ${budgetMinutes} minutes for this Ask turn. Finish earlier when the request is complete.`,
    ].join("\n")
  const deliverable = phaseDeliverable(spec)
  const successor = spec.handoff?.successor
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase) ?? "security"
  return [
    `You are running the ${spec.phase} phase of the Cyberful ${workflow} workflow to completion, autonomously.`,
    `Your working directory is the workarea root (${spec.workareaCwd} on the host and \`/workspace\` inside cyberful-os); write all files relative to that root.`,
    "",
    "## Live TUI narration",
    "Briefly announce each meaningful work block and material result without exposing private reasoning.",
    "",
    // A named, non-negotiable deliverable — a persona hint alone was too weak (the Expert improvised a
    // RAW.md and never wrote RECON.md). State the EXACT filename and that the phase fails without it.
    ...(deliverable
      ? [
          "## Required deliverable",
          `Write the complete phase deliverable as \`${deliverable}\`; supporting files do not replace it.`,
          `Inside cyberful-os its exact path is \`/workspace/${deliverable}\`; do not recreate a host \`work/...\` prefix below \`/workspace\`.`,
          "",
        ]
      : []),
    ...(spec.handoff
      ? [
          "## Required handoff",
          successor
            ? `After the deliverable is complete, call \`handoff\` exactly once to advance to \`${successor}\`.`
            : "After the deliverable is complete, call `handoff` exactly once to complete the engagement.",
          `Pass a concise \`summary\` and \`artifact: \"${deliverable ?? "."}\"\`. ` +
            (successor ? `Omit \`target\` or set it to \`${successor}\`.` : "Omit `target` or set it to `complete`."),
          "Stop after the handoff is accepted.",
          "",
        ]
      : []),
    ...(spec.phase === "report"
      ? [
          "## Runtime provenance",
          "Read the host-owned `raw/phase-manifests/**.runtime.json` files. Reflect subsystem failures or",
          "incomplete runtime execution as a coverage/evidence limitation where it materially affects the",
          "report. Do not include subsystem secrets or private runtime instructions.",
          "",
        ]
      : []),
    ...(novelty
      ? [
          "## Contrarian pass",
          "Use `hypothesis` for target-specific hypotheses and its `synthesize` action for the contrarian pass. If ideas converge, pivot across a genuinely different mechanism, boundary, protocol, state, capability, or oracle; route variation alone is coverage, not causal novelty.",
          "Before handoff, synthesize either the semantic pivots you exercised or target-specific evidence that useful diversification is exhausted. There are no numeric quotas.",
          "",
        ]
      : []),
    "## Time budget",
    `You have at most ${budgetMinutes} minutes. Explore thoroughly while preserving time for the deliverable and handoff.`,
    ...(closeoutMinutes > 0
      ? [
          `The host reserves the final ${closeoutMinutes} minutes for closeout. At that boundary it stops research and permits only local evidence review, deliverable and ledger reconciliation, cleanup, and handoff.`,
        ]
      : []),
    "",
    "## Standing rules",
    workflow === "code-audit"
      ? "- MISSION.md and program policy define scope and effects. Record silence as POLICY_UNKNOWN; ask only when a concrete action depends on it."
      : "- MISSION.md and program policy define scope and effects. UNRESOLVED applies only to one exact action/asset after an evidenced resolution attempt; it never blocks independent IN_SCOPE work.",
    "- Keep artifacts under the workarea (`/workspace` in containers). It is not a Git repository.",
    "- Every `delegate_task` call must name one workarea-relative `output_artifact`; children update it incrementally.",
    "- Store reusable values and secrets with `variable`; cite evidence and redact secrets or unnecessary sensitive data.",
    "- Track created test state through cleanup. A visible residual is a result, not an automatic approval gate.",
    "- Browser profiles 1–5 are separate target identities; keep their state and evidence separate.",
    ...(workflow !== "code-audit"
      ? [
          "- Use `web_search` or browser `profile: \"search\"` only for public research, never as target identity, scope authority, or a substitute for retained target evidence.",
        ]
      : []),
    "- Use `question` only for a concrete missing authorization, fact, or human CAPTCHA action.",
    "- Do not retry a target request that returns HTTP `429`. Cyberful adds no retry rule for other outcomes.",
    "- Check HTTP status/content type and inspect JSON shape before parsing; tolerate optional fields in `jq` and scripts.",
    "- For a CAPTCHA, preserve and foreground the challenged page, ask with `question kind=captcha`, then confirm resolution with `browser_captcha_status`. Other work continues.",
    ...(spec.phase !== "report"
      ? [
          "- Record hypotheses before testing, update them after each result, and close or queue them to the exact successor before handoff.",
        ]
      : []),
    ...(workflow !== "code-audit" && ["recon", "exploit", "hacker", "verify"].includes(spec.phase)
      ? [
          "- Treat the Brief matrix as a floor; add discoveries and queue unfinished hypotheses to the exact successor.",
          "- Use `finding` as soon as positive target evidence supports SUSPECTED; `record` requires a cautious provisional INFO/LOW/MEDIUM/HIGH/CRITICAL severity. Do not register mere hypotheses or backlog.",
          "- Revisit historical findings and persist every changed decision.",
          "- Use `zap_api_catalog` before `zap_api_call`; supply its required parameters.",
          ...(spec.phase === "exploit" || spec.phase === "hacker"
            ? [
                "- Before handoff, list findings; the host snapshots both registries and validates positive links.",
              ]
            : []),
          ...(spec.phase === "verify"
            ? [
                "- Before handoff, give every current finding its final workflow verification and Bug Bounty submission decision.",
              ]
            : []),
        ]
      : []),
    ...(workflow === "bug-bounty" && ["recon", "exploit", "hacker", "verify"].includes(spec.phase)
      ? [
          "- Answer each finding maturation checkpoint through authorized evidence; maximize supportable impact and prioritize host-derived published monetary upside, then proof proximity and test cost.",
          '- For every positive finding, answer: "What can an attacker actually achieve with this vulnerability?" Reconstruct an evidence-backed end-to-end path from prerequisites and entry point through attacker actions and crossed security boundaries to a concrete outcome; mark every unproven link as a gap and test the cheapest authorized discriminator.',
          ...(spec.phase === "verify"
            ? [
                "- Reconcile every remaining PURSUE assessment to MAXIMIZED or DEFERRED with an evidence-backed ceiling or exact resume condition.",
              ]
            : []),
        ]
      : []),
    ...(workflow === "bug-bounty" && spec.phase === "brief"
      ? [
          "- Read official reward tiers autonomously and call `reward_policy set`; use NOT_PUBLISHED or UNAVAILABLE instead of inferred values.",
        ]
      : []),
    ...(workflow === "bug-bounty" && spec.phase === "report"
      ? [
          "- Use `reward_policy get`; put host-derived published bands only in BUG_BOUNTY_REPORT.md and omit reward expectations from portable BBP-### submissions.",
          "- For every reported finding, state the evidence-backed end-to-end attack path as prerequisites -> attacker actions -> crossed security boundary -> concrete outcome; label any unsupported link instead of implying it.",
        ]
      : []),
    ...(workflow === "pentest" && ["exploit", "hacker", "verify"].includes(spec.phase)
      ? [
          "- Use each technical finding maturation checkpoint to test the strongest defensible impact and persist PURSUE, MAXIMIZED, or DEFERRED; monetary reward policy does not apply to Pentest.",
          '- For every positive finding, answer: "What can an attacker actually achieve with this vulnerability?" Reconstruct an evidence-backed end-to-end path from prerequisites and entry point through attacker actions and crossed security boundaries to a concrete outcome; mark every unproven link as a gap and test the cheapest authorized discriminator.',
        ]
      : []),
    ...(workflow === "code-audit" && ["trace", "hunt", "attack", "verify"].includes(spec.phase)
      ? [
          "- Use `hypothesis` as the durable lifecycle for threat paths and candidate mechanisms. Reference stable Code Graph node/path IDs with graph_refs.",
          "- Before handoff, close each phase-owned hypothesis or queue it to the exact successor with a concrete next step. Do not promote a graph path to `code_finding` until positive evidence supports SUSPECTED.",
        ]
      : []),
    ...(spec.phase === "report"
      ? [
          "- The `finding` registry is read-only in Report; use list/get and report its structured decisions.",
          "- The `hypothesis` registry is read-only in Report; keep unresolved hypotheses in a separate validation backlog.",
        ]
      : []),
    ...(spec.handoff
      ? [
          "- Do your work, write your artifact(s), then call `handoff` with the structured summary. The next",
          "  phase reads that summary and the workarea, not this phase's transcript.",
        ]
      : [
          "- Do your work, write your artifact(s), and end with a concise structured summary. The phase result",
          "  phase reads the workarea, not this phase's transcript.",
        ]),
  ].join("\n")
}

// Read once at the process boundary. Invalid configuration still yields a finite ceiling, and the
// resolution carries its warning into the durable status rather than hiding the default in a catch.
interface PhasePolicyResolution extends SubsystemPhase.BudgetResolution {
  readonly closeout: SubsystemPhase.CloseoutResolution
  readonly novelty?: NoveltyContract
  readonly noveltyWarning?: string
}

async function readBudget(
  read: PhaseDeps["readFile"],
  budgetsPath: string,
  phase: string,
  defaultMinutes: number,
): Promise<PhasePolicyResolution> {
  try {
    const parsed: unknown = JSON.parse(await read(budgetsPath))
    const budget = SubsystemPhase.resolveBudgetMinutes(parsed, phase, defaultMinutes)
    const closeout = SubsystemPhase.resolveCloseoutMinutes(parsed, phase, budget.minutes)
    const novelty = SubsystemNovelty.resolve(parsed, phase)
    return {
      ...budget,
      closeout,
      ...(novelty.contract ? { novelty: novelty.contract } : {}),
      ...(novelty.warning ? { noveltyWarning: novelty.warning } : {}),
    }
  } catch (error) {
    const defaultBudget = SubsystemPhase.resolveBudgetMinutes(undefined, phase, defaultMinutes)
    return {
      ...defaultBudget,
      closeout: SubsystemPhase.resolveCloseoutMinutes(undefined, phase, defaultBudget.minutes),
      warning: `Could not load budget configuration: ${errorDetail(error)} ${defaultBudget.warning ?? ""}`.trim(),
    }
  }
}

async function readHandoff(
  read: PhaseDeps["readFile"],
  signalPath: string,
  spec: PhaseSpec,
): Promise<{ value?: PhaseHandoff; warning?: string; missing: boolean }> {
  try {
    const parsed: unknown = JSON.parse(await read(signalPath))
    if (!isRecord(parsed)) return { warning: "Required handoff is not a JSON object.", missing: false }
    const successor = typeof parsed.successor === "string" ? parsed.successor : undefined
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : ""
    const artifact = typeof parsed.artifact === "string" ? parsed.artifact : undefined
    const completion = SubsystemCompletion.parseCandidate(parsed.completion)
    const snapshot = parseHandoffSnapshot(parsed.snapshot)
    const verdicts = SubsystemVerdict.parse(parsed.verdicts)
    if (parsed.phase !== spec.phase)
      return { warning: "Handoff phase does not match the running phase.", missing: false }
    if (successor !== spec.handoff?.successor)
      return { warning: "Handoff successor does not match the configured chain.", missing: false }
    if (!summary) return { warning: "Handoff summary is empty.", missing: false }
    if (parsed.snapshot !== undefined && !snapshot)
      return { warning: "Handoff snapshot failed its V2 integrity check.", missing: false }
    if (SubsystemVerdict.requiredFor(spec.workflow, spec.phase) && !snapshot && !verdicts)
      return { warning: "Handoff requires a host-owned V2 snapshot for this phase.", missing: false }
    return {
      value: {
        phase: spec.phase,
        successor,
        summary,
        artifact,
        completion,
        ...(verdicts ? { verdicts } : {}),
        ...(snapshot ? { snapshot } : {}),
      },
      missing: false,
    }
  } catch (error) {
    const missing = errorCode(error) === "ENOENT"
    return {
      warning: missing
        ? "Required handoff was not completed: no handoff was recorded."
        : `Required handoff was not completed: ${errorDetail(error)}`,
      missing,
    }
  }
}

function processTermination(result: SubsystemCli.RunResult): SubsystemCli.RunTermination {
  if (result.termination) return result.termination
  if (result.timedOut) return "budget_exhausted"
  if (result.exitCode === 127) return "spawn_failed"
  return result.exitCode === 0 ? "completed" : "subsystem_failed"
}

async function readRequiredUpstreamFailure(
  reader: PhaseDeps["readUpstreamFailureSignal"],
  signalPath: string,
  spec: PhaseSpec,
): Promise<{ readonly value?: PhaseFailure; readonly warning?: string }> {
  if (!reader) return {}
  try {
    const parsed: unknown = JSON.parse(await reader(signalPath))
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.phase !== spec.phase ||
      parsed.source !== "upstream" ||
      parsed.class !== "required_upstream_unavailable" ||
      typeof parsed.detail !== "string" ||
      parsed.detail.length === 0 ||
      parsed.detail.length > 500 ||
      parsed.retryable !== true ||
      (parsed.code !== undefined && (typeof parsed.code !== "string" || parsed.code.length > 100))
    )
      return {
        value: {
          phase: spec.phase,
          source: "upstream",
          class: "required_upstream_unavailable",
          detail: "A required phase upstream failed, but its private causal record was invalid.",
          retryable: true,
        },
        warning: "The required-upstream failure signal failed host validation.",
      }
    return {
      value: {
        phase: spec.phase,
        source: "upstream",
        class: "required_upstream_unavailable",
        ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
        detail: parsed.detail,
        retryable: true,
      },
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {}
    return {
      value: {
        phase: spec.phase,
        source: "upstream",
        class: "required_upstream_unavailable",
        detail: "A required phase upstream failed, but its private causal record could not be read.",
        retryable: true,
      },
      warning: `Could not read the required-upstream failure signal: ${errorDetail(error)}`,
    }
  }
}

// ── One Primary Failure Owns The Terminal Explanation ────────────
// A provider error often causes missing output and handoff evidence downstream.
// Rendering every consequence as an equal warning obscures the initiating fault.
// This classifier therefore selects one stable, redacted cause in causal order;
// remaining cleanup and validation diagnostics stay as secondary warnings.
// Orchestration and the TUI consume this field instead of inferring severity from
// warning text or an otherwise successful process exit.
// ─────────────────────────────────────────────────────────────────
function phaseFailure(input: {
  readonly spec: PhaseSpec
  readonly run: SubsystemCli.RunResult
  readonly upstreamFailure?: PhaseFailure
  readonly termination: SubsystemCli.RunTermination
  readonly deliverable?: string
  readonly deliverableExists: boolean
  readonly manifestWarning?: string
  readonly gatewayExited: boolean
  readonly handoffWarning?: string
  readonly readinessWarning?: string
  readonly summary: string
}): PhaseFailure | undefined {
  if (input.upstreamFailure) return input.upstreamFailure
  const provider = input.run.failure
  if (provider)
    return {
      phase: input.spec.phase,
      source: "provider",
      class: provider.kind,
      ...(provider.providerCode ? { code: provider.providerCode } : {}),
      detail: provider.detail ?? `The configured provider ended the phase with ${provider.kind}.`,
      retryable: provider.retryable,
    }
  if (input.termination === "spawn_failed")
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: "spawn_failed",
      code: String(input.run.exitCode),
      detail: input.run.failureReason ?? "The phase runtime failed before the worker could start.",
    }
  if (!input.deliverableExists && input.deliverable)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "required_deliverable_missing",
      code: input.deliverable,
      detail: `Required deliverable '${input.deliverable}' is missing.`,
    }
  if (input.manifestWarning)
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: "artifact_manifest_failed",
      detail: input.manifestWarning,
    }
  if (!input.gatewayExited)
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: "gateway_exit_unverified",
      detail: "The phase gateway did not exit cleanly, so no successor may start.",
    }
  if (input.handoffWarning)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "handoff_invalid",
      detail: input.handoffWarning,
    }
  if (input.readinessWarning)
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "successor_readiness_failed",
      detail: input.readinessWarning,
    }
  if (
    (input.termination !== "completed" || input.run.exitCode !== 0) &&
    input.termination !== "budget_exhausted" &&
    input.termination !== "shutdown"
  )
    return {
      phase: input.spec.phase,
      source: "lifecycle",
      class: input.termination,
      code: String(input.run.exitCode),
      detail: input.run.failureReason ?? `The phase runtime exited with code ${input.run.exitCode}.`,
    }
  if (!input.summary.trim())
    return {
      phase: input.spec.phase,
      source: "contract",
      class: "summary_missing",
      detail: "The phase returned no final summary.",
    }
}

function statusTranscript(stdout: string, result: PhaseResult): string {
  const status = JSON.stringify({
    type: "cyberful.phase.status",
    phase: result.phase,
    ok: result.ok,
    termination: result.termination,
    backend: result.backend,
    durationMs: result.durationMs,
    limitMs: result.limitMs,
    effectiveLimitMs: result.effectiveLimitMs,
    deadlineAt: result.deadlineAt,
    approvalWaitMs: result.approvalWaitMs,
    retryWaitMs: result.retryWaitMs,
    targetCooldownWaitMs: result.targetCooldownWaitMs,
    retryCompensationMs: result.retryCompensationMs,
    retryCompensationCapMs: result.retryCompensationCapMs,
    retryCompensationCapReached: result.retryCompensationCapReached,
    closeoutReserveMs: result.closeoutReserveMs,
    exitCode: result.exitCode,
    subsystemFailure: result.subsystemFailure,
    phaseFailure: result.phaseFailure,
    recoveryPolicy: result.recoveryPolicy,
    warnings: result.warnings,
    handoff: result.handoff
      ? {
          successor: result.handoff.successor,
          artifact: result.handoff.artifact,
          verdicts: result.handoff.verdicts ? SubsystemVerdict.counts(result.handoff.verdicts) : undefined,
        }
      : undefined,
    usage: result.usage,
    contextChurn: result.contextChurn,
    reasoningObservability: result.reasoningObservability,
    agentRun: result.agentRun,
    noveltyContract: result.noveltyContract,
    artifactManifest: result.artifactManifest,
    runtimeManifest: result.runtimeManifest,
  })
  return `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${status}\n`
}

export async function persistStatusOnly(
  spec: PhaseSpec,
  result: PhaseResult,
  deps: PhaseDeps = defaultDeps(),
): Promise<void> {
  const runtimeManifest = deps.writeRuntimeManifest
  if (runtimeManifest) {
    const manifestPath = runtimeManifestPath(spec)
    const warning = await operationWarning("Could not persist the phase runtime manifest", () =>
      runtimeManifest(manifestPath, spec.workareaCwd, result),
    )
    if (warning) result.warnings.push(warning)
    else result.runtimeManifest = path.relative(spec.workareaCwd, manifestPath)
  }
  const transcriptPath = spec.transcriptPath
  const createTranscript = deps.createTranscript
  if (!transcriptPath || !createTranscript) return
  const warning = await operationWarning("Could not persist the phase status transcript", async () => {
    const transcript = await createTranscript(transcriptPath)
    await transcript.append(statusTranscript("", result))
    await transcript.close()
  })
  if (warning) result.warnings.push(warning)
}

function failedBeforeSpawn(input: {
  spec: PhaseSpec
  deps: PhaseDeps
  startedAt: number
  limitMs: number
  effectiveLimitMs: number
  deadlineAt: number
  termination: "budget_exhausted" | "spawn_failed"
  detail: string
  budgetWarnings: string[]
  phaseFailure?: PhaseFailure
  recoveryPolicy?: PhaseResult["recoveryPolicy"]
}): PhaseResult {
  return {
    phase: input.spec.phase,
    ok: false,
    summary: "",
    exitCode: input.termination === "spawn_failed" ? 127 : 128,
    timedOut: input.termination === "budget_exhausted",
    termination: input.termination,
    backend: input.deps.subsystem.name,
    durationMs: Math.max(0, (input.deps.now ?? Date.now)() - input.startedAt),
    limitMs: input.limitMs,
    effectiveLimitMs: input.effectiveLimitMs,
    deadlineAt: input.deadlineAt,
    warnings: [...input.budgetWarnings],
    ...(input.recoveryPolicy ? { recoveryPolicy: input.recoveryPolicy } : {}),
    ...(input.phaseFailure
      ? { phaseFailure: input.phaseFailure }
      : input.termination === "spawn_failed"
      ? {
          phaseFailure: {
            phase: input.spec.phase,
            source: "lifecycle",
            class: "phase_setup_failed",
            code: "127",
            detail: input.detail,
          } satisfies PhaseFailure,
        }
      : {}),
  }
}

function workareaInstructions(runtimePlatform: string | undefined): string {
  const platform = new Set(["Linux/ARM64 (aarch64)", "Linux/AMD64 (x86_64)"]).has(runtimePlatform ?? "")
    ? runtimePlatform
    : "Linux with an unattested architecture"
  return [
    "The workarea root is intentionally an artifact workspace, not a Git repository.",
    "Do not run repository-level Git probes such as `git status`, `git diff`, or `git rev-parse` there; inspect artifacts directly with filesystem commands.",
    "Use Git only when a phase explicitly materializes a nested repository or disposable lab, and run it with that repository's explicit working directory.",
    "When working with imported source code, use the host's native shell only for static-analysis operations such as `rg`, `sed`, `find`, and read-only Git queries. The host shell remains available for all other purposes, including networking and scripts that do not execute or load imported source.",
    "For dependency installation, package managers, builds, tests, scripts, binaries, services, or any other execution of imported source, call the cyberful-os `shell` MCP tool, displayed as `cyberful-os_shell`.",
    "The active workarea root is mounted inside cyberful-os at `/workspace`. Map a workarea-relative host path such as `relative/path` to `/workspace/relative/path`; never embed or guess an absolute host workarea path.",
    `The available cyberful-os laboratory build is ${platform}. Compare the target OS and architecture with this platform before planning dynamic exact-build execution. A target binary built for another OS or architecture is not natively executable here unless a purpose-built Cyberful tool explicitly supports it; preserve useful static analysis, but record dynamic proof as unavailable instead of repeatedly invoking the lab or executing imported target code on the host.`,
    "Network access remains available inside cyberful-os and may be used for dependency installation and target traffic authorized by `MISSION.md`.",
    "If cyberful-os cannot execute imported source, diagnose that environment or record the blocker; do not fall back to executing imported source on the host.",
  ].join("\n")
}

// ── Prompt Sources Resolve Before The Worker Starts ──────────────
// First-party policy always supplies the base template. A persona override may
// come only from an explicit trusted settings root and retains the canonical
// workflow-scoped identity; missing overrides fall back to the embedded persona.
// The provider-neutral compiler later renders every source exactly once.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
async function loadPhasePromptSources(
  spec: PhaseSpec,
  settings: Settings.Info,
  read: PhaseDeps["readFile"],
) {
  const workflow = spec.workflow ?? SubsystemPhase.workflowOf(spec.phase)
  if (!workflow) throw new Error(`cannot resolve workflow for phase '${spec.phase}'`)
  const builtinPersonaPath = SubsystemPhase.personaPath(spec.home, spec.phase, workflow)
  const personaID = `${path.basename(path.dirname(builtinPersonaPath))}/${path.basename(
    builtinPersonaPath,
    path.extname(builtinPersonaPath),
  )}`
  const settingsDirectory = spec.settingsDirectory ?? process.cwd()
  let personaPath = builtinPersonaPath
  let personaSource: string | undefined
  for (const configuredRoot of settings.instructions.persona_roots) {
    const root = path.resolve(settingsDirectory, configuredRoot)
    for (const candidate of [
      path.join(root, `${personaID}.md`),
      path.join(root, "agents", `${personaID}.md`),
    ]) {
      try {
        personaSource = await read(candidate)
        personaPath = candidate
        break
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
    }
    if (personaSource !== undefined) break
  }
  const [templateSource, fallbackPersona] = await Promise.all([
    read(SubsystemPhase.baseInstructionsPath(spec.home)),
    personaSource === undefined ? read(builtinPersonaPath) : Promise.resolve(undefined),
  ])
  return {
    workflow,
    personaID,
    personaPath,
    templateSource,
    personaSource: personaSource ?? fallbackPersona ?? "",
  }
}

export async function runPhase(spec: PhaseSpec, deps: PhaseDeps = defaultDeps()): Promise<PhaseResult> {
  const now = deps.now ?? Date.now
  const removeDirectory = deps.removeDirectory
  const removeFile = deps.removeFile
  const defaultMinutes = spec.timeoutMs > 0 ? spec.timeoutMs / 60_000 : SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES
  const budget = await readBudget(deps.readFile, SubsystemPhase.budgetsPath(spec.home), spec.phase, defaultMinutes)
  const limitMs = Math.round(budget.minutes * 60_000)
  const attemptLimitMs =
    (spec.attempt ?? 1) > 1 && spec.timeoutMs > 0 ? Math.min(limitMs, spec.timeoutMs) : limitMs
  const budgetWarnings = [budget.warning, budget.closeout.warning, budget.noveltyWarning].filter(
    (item): item is string => Boolean(item),
  )
  const beforeSetup = now()
  const initialDeadline = beforeSetup + attemptLimitMs
  const initialEffectiveLimitMs = attemptLimitMs
  const setupState = deps.createRunState?.({
    workarea: spec.workareaCwd,
    workflow: spec.workflow ?? SubsystemPhase.workflowOf(spec.phase) ?? "unknown",
    phase: spec.phase,
    attempt: spec.attempt ?? 1,
    deadlineAt: initialDeadline,
  })
  await setupState?.start()

  const promptSetup = await (async () => {
    const settingsDirectory = spec.settingsDirectory ?? process.cwd()
    const settings = await deps.loadSettings(settingsDirectory)
    const sources = await loadPhasePromptSources(spec, settings, deps.readFile)
    const configuredSkillRoots = settings.instructions.skill_roots.map((root) =>
      path.resolve(settingsDirectory, root),
    )
    const skills = await deps.discoverSkills([SubsystemPhase.skillRoot(spec.home), ...configuredSkillRoots])
    return { settings, sources, skills }
  })().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  if (!promptSetup.ok) {
    await setupState?.fail({ termination: "spawn_failed", failure: { class: "phase_setup_failed" } })
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      detail: `Phase setup failed: could not compile Pi runtime inputs: ${
        promptSetup.error instanceof Error ? promptSetup.error.message : String(promptSetup.error)
      }`,
      budgetWarnings,
    })
    await persistStatusOnly(spec, result, deps)
    return result
  }

  const retryPolicy = Settings.retryPolicy(promptSetup.value.settings)
  const phaseRecoveryPolicy = Settings.phaseRecoveryPolicy(promptSetup.value.settings)
  const recoveryPolicy: NonNullable<PhaseResult["recoveryPolicy"]> = {
    enabled: phaseRecoveryPolicy.enabled,
    maxRestarts: phaseRecoveryPolicy.max_restarts,
    useFallbackProvider: phaseRecoveryPolicy.use_fallback_provider,
    fallbackConfigured: Boolean(promptSetup.value.settings.agent.fallback_provider),
    automaticSecurityBlockEnabled:
      promptSetup.value.settings.agent.fallback.automatic_security_block.enabled,
    recoveryBonusMs: Settings.fallbackRecoveryBonusMs(promptSetup.value.settings),
  }
  const prepared = await (deps.preparePhase
    ? deps.preparePhase({ phase: spec.phase, attempt: spec.attempt ?? 1, signal: spec.abort })
    : Promise.resolve({ warnings: [] as readonly string[], env: {} as Readonly<Record<string, string>> })).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
  if (!prepared.ok) {
    const candidate = prepared.error
    const retryable = isRecord(candidate) && candidate.retryable === true
    const kind = isRecord(candidate) && typeof candidate.kind === "string"
      ? candidate.kind
      : "required_upstream_unavailable"
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      detail: `Required phase upstream failed preflight: ${errorDetail(candidate)}`,
      budgetWarnings,
      recoveryPolicy,
      phaseFailure: {
        phase: spec.phase,
        source: "upstream",
        class: kind,
        code: "127",
        detail: `Required phase upstream failed preflight: ${errorDetail(candidate)}`,
        retryable,
      },
    })
    await setupState?.fail({ termination: "spawn_failed", failure: { class: kind } })
    await persistStatusOnly(spec, result, deps)
    return result
  }
  budgetWarnings.push(...(prepared.value.warnings ?? []))
  const phaseEnvironment = { ...spec.env, ...prepared.value.env }

  const safeRunKey = spec.sessionID.replace(/[^a-zA-Z0-9_.-]/g, "-")
  // Signal files outlive their subprocess briefly, so every attempt gets a nonce. A gateway from a timed-out
  // attempt can never write into a retried phase's handoff or PID path.
  const signalKey = `${safeRunKey}-${process.pid}-${randomUUID()}`
  const phaseRootRunID = `run_${randomUUID()}`
  const handoffPath = spec.handoff ? path.join(os.tmpdir(), `expert-phase-handoff-${signalKey}.json`) : undefined
  const gatewayPidPath = path.join(os.tmpdir(), `expert-phase-gateway-pid-${signalKey}.json`)
  const upstreamFailurePath = path.join(os.tmpdir(), `expert-phase-upstream-failure-${signalKey}.json`)
  const budgetClock = SubsystemPhaseBudgetClock.create({
    deadlineAt: initialDeadline,
    retryCompensationCapMs: retryPolicy.max_phase_extension_minutes * 60_000,
    initialApprovalWaitMs: spec.budgetCarry?.approvalWaitMs,
    initialRetryWaitMs: spec.budgetCarry?.retryWaitMs,
    initialTargetCooldownWaitMs: spec.budgetCarry?.targetCooldownWaitMs,
    initialRetryCompensationMs: spec.budgetCarry?.phaseExtensionMs,
    recoveredChainIDs: spec.budgetCarry?.recoveryChainIDs,
    now,
  })
  const questionHandler = deps.askQuestion
  const askQuestion: AskHuman | undefined = questionHandler
    ? (questions, signal) => budgetClock.wait("approval", () => questionHandler(questions, signal))
    : undefined
  const shellTemporaryDirectory = path.join(spec.workareaCwd, ".cyberful-tmp")
  const engagementCircuitBreakerPath = circuitBreakerPath(spec.sessionID, "engagement")
  // The host exposes one explicit gateway connection while its private environment remains outside
  // AgentRun context. Phase handoff uses a fresh host-owned signal path so a stale
  // request from an interrupted run can never advance a later run.
  const gatewayOptions: SubsystemGateway.GatewayOptions = {
    proxy: true,
    phase: spec.phase,
    env: {
      ...phaseEnvironment,
      CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: spec.workareaCwd,
      CYBERFUL_SUBSYSTEM_LABEL: spec.phase,
      ...(spec.transcriptPath ? { CYBERFUL_SUBSYSTEM_SESSION_LOG_ROOT: path.dirname(spec.transcriptPath) } : {}),
      ...(spec.workflow ? { CYBERFUL_SUBSYSTEM_WORKFLOW: spec.workflow } : {}),
      ...(budget.novelty ? { [SubsystemNovelty.CONTRACT_ENV]: JSON.stringify(budget.novelty) } : {}),
      ...(spec.sourceRoot ? { CYBERFUL_SUBSYSTEM_SOURCE_ROOT: spec.sourceRoot } : {}),
    },
    pidSignalPath: gatewayPidPath,
    upstreamFailureSignalPath: upstreamFailurePath,
    questionEnabled: Boolean(askQuestion),
    circuitBreakerPath: engagementCircuitBreakerPath,
    ...(handoffPath
      ? {
          handoff: {
            phase: spec.phase,
            successor: spec.handoff?.successor,
            signalPath: handoffPath,
            artifact: phaseDeliverable(spec),
          },
        }
      : {}),
  }
  const mcpServer = SubsystemGateway.gatewayMcpServer(spec.sessionID, gatewayOptions)
  try {
    await deps.ensureDirectory(shellTemporaryDirectory)
    if (handoffPath) await deps.removeFile?.(handoffPath)
    await deps.removeFile?.(gatewayPidPath)
    await deps.removeFile?.(upstreamFailurePath)
  } catch (error) {
    const setupCleanupWarning = await operationWarning(
      "Could not remove the phase runtime directory after setup failed",
      removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
    )
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt: beforeSetup,
      limitMs,
      effectiveLimitMs: initialEffectiveLimitMs,
      deadlineAt: initialDeadline,
      termination: "spawn_failed",
      detail: `Phase setup failed: ${error instanceof Error ? error.message : String(error)}`,
      budgetWarnings,
    })
    if (setupCleanupWarning) result.warnings.push(setupCleanupWarning)
    await persistStatusOnly(spec, result, deps)
    return result
  }

  // Setup time counts against the phase budget, so the AgentRun receives only the remaining active-execution allowance.
  const startedAt = now()
  const deadlineAt = initialDeadline
  const effectiveLimitMs = Math.max(0, deadlineAt - startedAt)
  if (effectiveLimitMs <= 0) {
    const result = failedBeforeSpawn({
      spec,
      deps,
      startedAt,
      limitMs,
      effectiveLimitMs,
      deadlineAt,
      termination: "budget_exhausted",
      detail: "The phase budget elapsed during setup.",
      budgetWarnings,
    })
    result.warnings.push(
      ...(await operationWarnings([
        [
          "Could not remove the phase runtime directory after setup exhausted the budget",
          removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
        ],
      ])),
    )
    await persistStatusOnly(spec, result, deps)
    return result
  }

  const onActivity = deps.onActivity
  const phaseUsage = SubsystemUsage.createSessionCounter()
  const primaryUsageRun = {}
  const reasoningItems = new Set<string>()
  const reasoningSummaryItems = new Set<string>()
  const reasoningContentItems = new Set<string>()
  const reasoningDeltaItems = new Set<string>()
  const observeActivity = (run: object, activity: Subsystem.PhaseActivity): void => {
    if (activity.kind === "progress") phaseUsage.observe(run, activity.usage)
    if (activity.kind === "reasoning") {
      reasoningItems.add(activity.itemID)
      if (activity.hasSummary) reasoningSummaryItems.add(activity.itemID)
      if (activity.hasContent) reasoningContentItems.add(activity.itemID)
      if (activity.hasDelta) reasoningDeltaItems.add(activity.itemID)
    }
    onActivity?.(activity)
  }
  const semanticArtifact = phaseDeliverable(spec)
  let semanticHash: string | undefined
  let semanticCheckpoints = 0
  let lastSemanticProgressAt: number | undefined
  let semanticCheckpointWarning: string | undefined
  let checkpointQueue = Promise.resolve()
  const writeArtifactCheckpoint = deps.writeArtifactCheckpoint
  // ── Semantic Checkpoints Have One Serialized Owner ──────────────────
  // Subsystem events are synchronous observations, while checkpoint writes are
  // asynchronous filesystem replacements that can overlap when events arrive
  // quickly. One phase-owned promise tail serializes those writes and retains
  // their latest warning without failing the subsystem turn for a transiently
  // absent artifact. The phase awaits that owner before reading its final state,
  // so no checkpoint write survives cleanup or disappears as floating work.
  // ───────────────────────────────────────────────────────────────
  const queueSemanticProgressCapture = (): void => {
    if (!semanticArtifact || !writeArtifactCheckpoint) return
    checkpointQueue = checkpointQueue
      .then(async () => {
        const checkpoint = artifactCheckpointPath(spec)
        const sha256 = await writeArtifactCheckpoint(checkpoint, path.join(spec.workareaCwd, semanticArtifact))
        semanticCheckpointWarning = undefined
        if (sha256 === semanticHash) return
        semanticHash = sha256
        semanticCheckpoints += 1
        lastSemanticProgressAt = now()
        deps.onSemanticProgress?.({
          phase: spec.phase,
          artifact: semanticArtifact,
          checkpoint: path.relative(spec.workareaCwd, checkpoint),
          sha256,
          count: semanticCheckpoints,
          timestamp: lastSemanticProgressAt,
        })
      })
      // A deliverable may not exist yet or may be between an application's unlink-and-rename steps. The
      // previous checkpoint remains valid; a later activity retries without failing the phase.
      .catch((error) => {
        semanticCheckpointWarning = `Could not capture the latest artifact checkpoint: ${errorDetail(error)}`
      })
  }
  // ── Transcript Persistence Is Incremental And Phase-Owned ──────
  // A multi-hour phase can produce megabytes of AgentEvents before its terminal
  // result. Retaining those lines in memory and rewriting them only at shutdown
  // made live diagnosis impossible and amplified failure paths. The phase opens
  // one private writer before the AgentRun starts; the runtime serially appends
  // each already-redacted event, while the host appends its terminal status and
  // closes the resource after all validation is complete.
  // ─────────────────────────────────────────────────────────────────
  const transcriptPath = spec.transcriptPath
  const transcriptAttempt =
    transcriptPath && deps.createTranscript
      ? await deps.createTranscript(transcriptPath).then(
          (writer) => ({ writer, warning: undefined }),
          (error) => ({
            writer: undefined,
            warning: `Could not create the phase transcript: ${errorDetail(error)}`,
          }),
        )
      : { writer: undefined, warning: undefined }
  const transcript = transcriptAttempt.writer
  const stream = Boolean(onActivity) || Boolean(transcript)
  const runtimeInstructions = buildPhasePrompt(
    spec,
    Number((effectiveLimitMs / 60_000).toFixed(2)),
    budget.novelty,
    budget.closeout.minutes,
  )
  const compilePrompt = (
    role: "root" | "subagent" | "fallback",
    providerRoute: "main" | "fallback",
    userTask: string,
    handoffOwner: boolean,
  ) =>
    AgentPromptCompiler.compile({
      templateSource: promptSetup.value.sources.templateSource,
      personaSource: promptSetup.value.sources.personaSource,
      workareaSource: workareaInstructions(phaseEnvironment.CYBERFUL_OS_RUNTIME_PLATFORM),
      runtimeInstructions,
      workflow: promptSetup.value.sources.workflow,
      phase: spec.phase,
      personaID: promptSetup.value.sources.personaID,
      role,
      providerRoute,
      handoffOwner,
      delegationEnabled: promptSetup.value.settings.agent.subagents.enabled,
      fallback: {
        providerConfigured: Boolean(promptSetup.value.settings.agent.fallback_provider),
        proactiveEnabled: promptSetup.value.settings.agent.fallback.proactive.enabled,
        proactivePercentage: promptSetup.value.settings.agent.fallback.proactive.percentage,
        automaticSecurityBlockEnabled:
          promptSetup.value.settings.agent.fallback.automatic_security_block.enabled,
      },
      userTask,
      skills: promptSetup.value.skills.catalog,
    })
  const rootRoute = spec.providerRoute ?? "main"
  const rootPrompt = compilePrompt("root", rootRoute, spec.objective, Boolean(spec.handoff))
  const runInput: SubsystemCli.RunInput = {
    settings: promptSetup.value.settings,
    sessionID: spec.sessionID,
    rootRunID: phaseRootRunID,
    workarea: spec.workareaCwd,
    gateway: mcpServer,
    prompt: spec.objective,
    compiledPrompt: rootPrompt,
    compileChildPrompt: (input) =>
      compilePrompt(
        input.role,
        input.providerRoute,
        SubsystemPiAgent.formatTaskCapsule(input.task),
        false,
      ),
    task: {
      objective: spec.objective,
      ...(semanticArtifact ? { artifacts: [semanticArtifact] } : {}),
    },
    skills: promptSetup.value.skills,
    dynamicTools: deps.dynamicTools,
    deadlineAt,
    abort: spec.abort,
    timeoutMs: effectiveLimitMs,
    attempt: spec.attempt ?? 1,
    askQuestion,
    budgetClock,
    closeoutReserveMs: Math.round(budget.closeout.minutes * 60_000),
    handoffOwner: Boolean(spec.handoff),
    providerRoute: rootRoute,
    transcript,
    spec: {
      cwd: spec.workareaCwd,
      permission: { kind: "autonomous" },
      networkAccess: spec.workflow !== "code-audit",
      mcpServer,
      baseInstructions: rootPrompt.system,
      skillRoots: [SubsystemPhase.skillRoot(spec.home), ...promptSetup.value.settings.instructions.skill_roots],
      markdownArtifacts:
        semanticArtifact && /\.(?:md|markdown)$/i.test(semanticArtifact) ? [semanticArtifact] : [],
    },
  }

  queueSemanticProgressCapture()
  await checkpointQueue
  const projectActivityActor = Subsystem.createActivityActorProjection()

  // Streaming forwards activity to the live observer while Pi appends every
  // complete redacted event through the phase-owned transcript writer. The
  // terminal AgentRun result remains the authoritative summary in either mode.
  const primaryRun = await (
    stream
      ? deps.runStreaming(runInput, (event) => {
          queueSemanticProgressCapture()
          for (const activity of deps.subsystem.streamActivities(event)) {
            const projected = projectActivityActor(activity)
            if (projected) observeActivity(primaryUsageRun, projected)
          }
        })
      : deps.run(runInput)
  ).catch(
    (error): SubsystemCli.RunResult => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
      timedOut: false,
      termination: "spawn_failed",
    }),
  )
  queueSemanticProgressCapture()
  await checkpointQueue
  const budgetSnapshot = budgetClock.snapshot()
  const approvalWaitMs = Math.round(budgetSnapshot.approvalWaitMs)
  const retryWaitMs = Math.round(budgetSnapshot.retryWaitMs)
  const targetCooldownWaitMs = Math.round(budgetSnapshot.targetCooldownWaitMs)
  const retryCompensationMs = Math.round(budgetSnapshot.retryCompensationMs)
  const recoveryExtensionMs = Math.round(
    (spec.budgetCarry?.recoveryExtensionMs ?? 0) + budgetSnapshot.recoveryExtensionMs,
  )
  const pausedMs = Math.round(budgetSnapshot.pausedMs)
  budgetClock.close()
  const primaryTermination = processTermination(primaryRun)
  // The runtime promise resolves only after the phase-scoped Pi subsystem has closed its bridge. Gateway
  // upstreams may live in another process group, so reap it and prove it is gone before validating handoff.
  const gatewayExit =
    primaryTermination === "spawn_failed" || !deps.waitForGatewayExit
      ? ({ exited: true, warning: undefined } as const)
      : await deps.waitForGatewayExit(gatewayPidPath, 5_000, Boolean(spec.handoff)).then(
          (exited) => ({ exited, warning: undefined }),
          (error) => ({
            exited: false,
            warning: `Could not verify phase gateway shutdown: ${errorDetail(error)}`,
          }),
        )
  const primaryGatewayExited = gatewayExit.exited
  const lifecycleWarnings: string[] = []
  const primaryHandoff = handoffPath
    ? await readHandoff(deps.readFile, handoffPath, spec)
    : ({ value: undefined, warning: undefined, missing: false } as const)
  const primaryUpstreamFailure = await readRequiredUpstreamFailure(
    deps.readUpstreamFailureSignal,
    upstreamFailurePath,
    spec,
  )
  lifecycleWarnings.push(
    ...(primaryUpstreamFailure.warning ? [primaryUpstreamFailure.warning] : []),
    ...(await operationWarnings([
      [
        "Could not remove the phase handoff signal",
        handoffPath && removeFile ? () => removeFile(handoffPath) : undefined,
      ],
      ["Could not remove the phase gateway PID signal", removeFile ? () => removeFile(gatewayPidPath) : undefined],
      [
        "Could not remove the required-upstream failure signal",
        removeFile ? () => removeFile(upstreamFailurePath) : undefined,
      ],
    ])),
  )
  const primarySummary = primaryRun.agentResult?.output ?? deps.subsystem.extractResultText(primaryRun.stdout)
  const deliverable = phaseDeliverable(spec)
  const inspectDeliverable = async (): Promise<{ exists: boolean; warning?: string }> =>
    deliverable && deps.fileExists
      ? deps.fileExists(path.join(spec.workareaCwd, deliverable)).then(
          (exists) => ({ exists }),
          (error) => ({
            exists: false,
            warning: `Could not inspect the required deliverable '${deliverable}': ${errorDetail(error)}`,
          }),
        )
      : { exists: true }
  const deliverableCheck = await inspectDeliverable()
  const rawTermination = primaryTermination
  const gatewayExited = primaryGatewayExited
  const handoff = primaryHandoff
  const subsystemSummary = primarySummary
  const deliverableExists = deliverableCheck.exists
  // REPORT.md is intentionally finalized later by the host's variable-resolution/PDF boundary. Its
  // manifest is written there; hashing it here would become stale after that authorized host mutation.
  const manifest =
    deliverable && deliverableExists && spec.phase !== "report" && deps.writeArtifactManifest
      ? {
          path: artifactManifestPath(spec),
          artifact: path.join(spec.workareaCwd, deliverable),
          write: deps.writeArtifactManifest,
        }
      : undefined
  const manifestWarning = manifest
    ? await manifest
        .write(manifest.path, manifest.artifact)
        .then(() => undefined)
        .catch(
          (error) =>
            `Could not write the final artifact manifest: ${error instanceof Error ? error.message : String(error)}`,
        )
    : undefined
  const runtimeCleanupWarning = await operationWarning(
    "Could not remove the phase runtime directory",
    removeDirectory ? () => removeDirectory(shellTemporaryDirectory) : undefined,
  )

  // ── A Budget Cutoff Advances Only A Sealed Partial Artifact ────────
  // Active-execution exhaustion is an expected scheduler boundary for research
  // phases. If the cutoff arrives before their handoff, the host may synthesize
  // that record only after the required artifact is sealed and the gateway is
  // proven gone. Brief is deliberately excluded: a partial MISSION.md remains a
  // recovery checkpoint, but cannot authorize target work without an explicit
  // handoff. Malformed handoffs and failed lifecycle gates also fail closed.
  //
  // @docs/concepts/execution-model.md
  // ─────────────────────────────────────────────────────────────────
  const canSynthesizeBudgetHandoff =
    rawTermination === "budget_exhausted" &&
    spec.phase !== "brief" &&
    spec.handoff !== undefined &&
    handoff.missing &&
    deliverable !== undefined &&
    deliverableExists &&
    !manifestWarning &&
    !primaryUpstreamFailure.value &&
    gatewayExited
  const synthesizedHandoff: PhaseHandoff | undefined = canSynthesizeBudgetHandoff
    ? {
        phase: spec.phase,
        successor: spec.handoff?.successor,
        summary: [
          `The ${spec.phase} phase exhausted its active-execution budget. Continue from the sealed partial deliverable '${deliverable}' and treat unfinished coverage as degraded.`,
          subsystemSummary.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
        artifact: deliverable,
      }
    : undefined
  const acceptedHandoff = handoff.value ?? synthesizedHandoff
  const handoffWarning = synthesizedHandoff ? undefined : handoff.warning
  const summary = acceptedHandoff?.summary ?? subsystemSummary
  const readinessRequired =
    spec.workflow === "code-audit" && spec.phase === "index" && acceptedHandoff?.successor === "trace"
  const readinessWarning = readinessRequired
    ? !gatewayExited
      ? "Code Audit index readiness was not evaluated because the phase gateway is still live; trace is blocked."
      : deps.verifyCodeGraphReadiness
        ? await deps
            .verifyCodeGraphReadiness({
              ...spec.env,
              CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: spec.workareaCwd,
              ...(spec.workflow ? { CYBERFUL_SUBSYSTEM_WORKFLOW: spec.workflow } : {}),
              ...(spec.sourceRoot ? { CYBERFUL_SUBSYSTEM_SOURCE_ROOT: spec.sourceRoot } : {}),
            })
            .then(() => undefined)
            .catch((error) => `Code Audit index readiness failed; trace is blocked: ${errorDetail(error)}`)
        : "Code Audit index readiness verifier is unavailable; trace is blocked."
    : undefined
  const budgetAdvanceWarning =
    rawTermination === "budget_exhausted" &&
    acceptedHandoff &&
    deliverable !== undefined &&
    deliverableExists &&
    !manifestWarning &&
    gatewayExited
      ? synthesizedHandoff
        ? `Phase budget exhausted before an explicit handoff; advancing with sealed partial deliverable '${deliverable}'.`
        : `Phase budget exhausted after a valid handoff; advancing with sealed deliverable '${deliverable}'.`
      : undefined
  const ok =
    ((rawTermination === "completed" && primaryRun.exitCode === 0) ||
      (rawTermination === "budget_exhausted" && spec.handoff !== undefined && acceptedHandoff !== undefined)) &&
    summary.trim().length > 0 &&
    deliverableExists &&
    !manifestWarning &&
    gatewayExited &&
    !primaryUpstreamFailure.value &&
    !handoffWarning &&
    !readinessWarning
  const primaryFailure = ok
    ? undefined
    : phaseFailure({
        spec,
        run: primaryRun,
        upstreamFailure: primaryUpstreamFailure.value,
        termination: rawTermination,
        deliverable,
        deliverableExists,
        manifestWarning,
        gatewayExited,
        handoffWarning,
        readinessWarning,
        summary,
      })
  const warnings = [
    ...budgetWarnings,
    ...(transcriptAttempt.warning ? [transcriptAttempt.warning] : []),
    ...(deliverableCheck.warning && primaryFailure?.class !== "required_deliverable_missing"
      ? [deliverableCheck.warning]
      : []),
    ...(runtimeCleanupWarning ? [runtimeCleanupWarning] : []),
    ...(semanticCheckpointWarning ? [semanticCheckpointWarning] : []),
    ...lifecycleWarnings,
    ...(gatewayExit.warning && primaryFailure?.class !== "gateway_exit_unverified" ? [gatewayExit.warning] : []),
    ...(budgetAdvanceWarning ? [budgetAdvanceWarning] : []),
  ]
  const observedUsage = phaseUsage.usage()
  const hasObservedUsage =
    observedUsage.input > 0 ||
    observedUsage.output > 0 ||
    observedUsage.reasoning > 0 ||
    observedUsage.cache.read > 0 ||
    observedUsage.cache.write > 0
  const result: PhaseResult = {
    phase: spec.phase,
    ok,
    summary,
    exitCode: primaryRun.exitCode,
    timedOut: rawTermination === "budget_exhausted",
    termination: rawTermination === "completed" ? (ok ? "completed" : "subsystem_failed") : rawTermination,
    backend: deps.subsystem.name,
    durationMs: Math.max(0, now() - startedAt - pausedMs),
    limitMs,
    effectiveLimitMs: Math.max(0, Math.round(budgetSnapshot.deadlineAt - startedAt)),
    deadlineAt: Math.round(budgetSnapshot.deadlineAt),
    approvalWaitMs,
    retryWaitMs,
    targetCooldownWaitMs,
    retryCompensationMs,
    retryCompensationCapMs: budgetSnapshot.retryCompensationCapMs,
    retryCompensationCapReached: budgetSnapshot.retryCompensationCapReached,
    recoveryExtensionMs,
    closeoutReserveMs: Math.round(budget.closeout.minutes * 60_000),
    warnings,
    handoff: acceptedHandoff,
    artifactManifest: manifest && !manifestWarning ? path.relative(spec.workareaCwd, manifest.path) : undefined,
    semanticCheckpoints: semanticCheckpoints || undefined,
    lastSemanticProgressAt,
    subsystemFailure: primaryRun.failure,
    phaseFailure: primaryFailure,
    usage: hasObservedUsage ? observedUsage : undefined,
    contextChurn: hasObservedUsage ? SubsystemUsage.contextChurn(observedUsage) : undefined,
    reasoningObservability: {
      items: reasoningItems.size,
      summaryItems: reasoningSummaryItems.size,
      contentItems: reasoningContentItems.size,
      deltaItems: reasoningDeltaItems.size,
      textStatus:
        reasoningSummaryItems.size > 0 || reasoningContentItems.size > 0 || reasoningDeltaItems.size > 0
          ? "published"
          : observedUsage.reasoning > 0 || reasoningItems.size > 0
            ? "only counters received"
            : "no reasoning observed",
    },
    ...(primaryRun.agentResult
      ? {
          agentRun: {
            id: primaryRun.agentResult.id,
            provider: primaryRun.agentResult.provider,
            model: primaryRun.agentResult.model,
            providerAffinity: primaryRun.agentResult.providerAffinity,
            reasoningEffort: primaryRun.agentResult.reasoningEffort,
            effectiveReasoningEffort: primaryRun.agentResult.effectiveReasoningEffort,
            context: primaryRun.agentResult.context,
            promptManifest: primaryRun.agentResult.promptManifest,
            childRunIDs: primaryRun.agentResult.childRunIDs,
            skillsUsed: primaryRun.agentResult.skillsUsed,
            toolCalls: primaryRun.agentResult.toolCalls,
            fallbackAdmissions: primaryRun.agentResult.fallbackAdmissions,
            fallbackDescendants: primaryRun.agentResult.fallbackDescendants,
          },
        }
      : {}),
    noveltyContract: budget.novelty,
    recoveryPolicy: {
      enabled: Settings.phaseRecoveryPolicy(promptSetup.value.settings).enabled,
      maxRestarts: Settings.phaseRecoveryPolicy(promptSetup.value.settings).max_restarts,
      useFallbackProvider: Settings.phaseRecoveryPolicy(promptSetup.value.settings).use_fallback_provider,
      fallbackConfigured: Boolean(promptSetup.value.settings.agent.fallback_provider),
      automaticSecurityBlockEnabled:
        promptSetup.value.settings.agent.fallback.automatic_security_block.enabled,
      recoveryBonusMs: Settings.fallbackRecoveryBonusMs(promptSetup.value.settings),
    },
  }

  const runtimeManifest = deps.writeRuntimeManifest
  if (runtimeManifest) {
    const manifestPath = runtimeManifestPath(spec)
    const warning = await operationWarning("Could not persist the phase runtime manifest", () =>
      runtimeManifest(manifestPath, spec.workareaCwd, result),
    )
    if (warning) result.warnings.push(warning)
    else result.runtimeManifest = path.relative(spec.workareaCwd, manifestPath)
  }

  // A killed phase retains every subsystem event received before the group kill, followed by one host
  // status record. This makes a partial excursion auditable without placing stderr or secrets on the bus.
  if (transcript) {
    const transcriptWarning = await operationWarning("Could not persist the phase transcript", async () => {
      await transcript.append(statusTranscript("", result))
      await transcript.close()
    })
    if (transcriptWarning) result.warnings.push(transcriptWarning)
  }
  if (result.ok && spec.handoff && !spec.handoff.successor && removeDirectory) {
    const breakerWarning = await operationWarning("Could not remove the completed engagement circuit breakers", () =>
      removeDirectory(circuitBreakerDirectory(spec.sessionID)),
    )
    if (breakerWarning) result.warnings.push(breakerWarning)
  }
  return result
}

export * as SubsystemPhaseRunner from "./phase-runner"
